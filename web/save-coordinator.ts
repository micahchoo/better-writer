/**
 * save-coordinator: the draft-save state machine behind EditorApp.
 *
 * One instance serializes every draft save: edits debounce for a second,
 * a failed save keeps its payload and gets exactly ONE silent retry, and
 * flush() forces an immediate send (the tab-hide / page-unload path).
 * Overlapping calls can never double-send: any pending timer is cleared
 * before a new one is scheduled, and an in-flight flag makes concurrent
 * trySave/flush calls skip instead of POSTing the same draft twice.
 */

import type { DraftStore, Note } from './draft-store';

const SAVE_DELAY_MS = 1000;

/** Thrown when trySave/flush find no active store (mode still detecting).
 * Treated exactly like any other save failure — payload kept, one silent
 * retry, then onError — so a null store never fakes a 'saved' pulse. */
const NO_STORE_ERROR = 'No active storage yet — the draft has not been saved.';

export interface SaveCoordinatorOptions {
  /** Supplies the active store per call, so a mode change is picked up. */
  getStore: () => DraftStore | null;
  /** Routes save failures to the component's error surface. */
  onError(err: unknown): void;
  /** Reports save lifecycle for a UI pulse: 'saving' on send, 'saved' on confirmed persist. */
  onSaveState?(phase: 'saving' | 'saved'): void;
}

interface SavePayload {
  draft: string;
  notes: Note[];
}

export class SaveCoordinator {
  private readonly options: SaveCoordinatorOptions;
  /** Set by dispose(); a disposed coordinator never arms another save (H3-2). */
  private disposed = false;

  private debounceTimer: number | null = null;
  private retryTimer: number | null = null;
  /** A retry is armed after the first failure; the second failure surfaces and stops. */
  private retryScheduled = false;
  /** A save is in flight — overlapping trySave/flush calls skip rather than double-send. */
  private inFlight = false;
  private pending: SavePayload | null = null;

  constructor(options: SaveCoordinatorOptions) {
    this.options = options;
  }

  /** Record the newest payload and restart the 1 s debounce. */
  edit(text: string, notes: Note[]): void {
    this.clearTimers();
    this.retryScheduled = false; // a fresh edit re-arms a clean save cycle
    this.pending = { draft: text, notes };
    this.scheduleDebounce();
  }

  /**
   * Persist an out-of-band change (a note added, resolved, or cleared)
   * immediately, superseding anything the debounce would have sent. The
   * payload is recorded BEFORE saving so a failed flush keeps it pending —
   * failure semantics match flush(), not edit().
   */
  async persistNow(text: string, notes: Note[]): Promise<void> {
    this.pending = { draft: text, notes };
    await this.flush();
  }

  /**
   * Attempt a save now (fire-and-forget). The first failure keeps the
   * payload and arms ONE retry; that retry's failure surfaces via onError
   * and stops — the next edit() re-arms naturally.
   *
   * Failure modes: a store that rejects, and NO active store (mode still
   * detecting) — both follow the same path, so a null store keeps the
   * payload pending, never pulses 'saved', and surfaces onError on the
   * retry's failure.
   */
  async trySave(): Promise<void> {
    this.clearTimers();
    if (this.disposed || this.pending === null || this.inFlight) return;
    const payload = this.pending;
    const isRetry = this.retryScheduled;
    this.retryScheduled = false;
    this.inFlight = true;
    try {
      this.options.onSaveState?.('saving');
      const store = this.store;
      if (store === null) throw new Error(NO_STORE_ERROR);
      await store.save(payload.draft, payload.notes);
      // Claim 'saved' only when this payload is still the latest — a newer
      // edit superseded it mid-flight and owns the next pulse.
      if (this.pending === payload) {
        this.pending = null;
        this.options.onSaveState?.('saved');
      }
    } catch (err) {
      if (isRetry) {
        this.options.onError(err);
      } else {
        this.retryScheduled = true;
        this.scheduleRetry();
      }
    } finally {
      this.inFlight = false;
      // A newer payload arrived while this save ran (via edit(), which arms
      // its own debounce, or persistNow(), which does not): if no timer is
      // already armed for it, re-arm the debounce so it still gets persisted.
      if (
        !this.disposed &&
        this.pending !== null &&
        this.pending !== payload &&
        this.debounceTimer === null
      ) {
        this.scheduleDebounce();
      }
    }
  }

  /**
   * Force an immediate save (tab hidden / page unloading). Failures surface
   * via onError and keep the payload — the next edit() re-arms. A missing
   * store (mode still detecting) fails the same way, never pulsing 'saved'.
   */
  async flush(opts?: { keepalive?: boolean }): Promise<void> {
    this.clearTimers();
    this.retryScheduled = false;
    if (this.disposed || this.pending === null || this.inFlight) return;
    const payload = this.pending;
    this.inFlight = true;
    try {
      this.options.onSaveState?.('saving');
      const store = this.store;
      if (store === null) throw new Error(NO_STORE_ERROR);
      await store.save(payload.draft, payload.notes, opts);
      if (this.pending === payload) {
        this.pending = null;
        this.options.onSaveState?.('saved');
      }
    } catch (err) {
      this.options.onError(err);
    } finally {
      this.inFlight = false;
      if (
        !this.disposed &&
        this.pending !== null &&
        this.pending !== payload &&
        this.debounceTimer === null
      ) {
        this.scheduleDebounce();
      }
    }
  }

  /**
   * Cancel pending timers (component unmount). Latches `disposed`, which the
   * finally-block re-arm consults: clearing the timers alone could not stop a
   * save that was already IN FLIGHT from arming a fresh debounce as it
   * settled, so a newer payload was persisted strictly after unmount — and
   * `getStore()` is read at fire time, so the ghost save could even land in a
   * mode-switched store (H3-2). Disposal is final; a disposed coordinator
   * never saves again.
   */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private get store(): DraftStore | null {
    return this.options.getStore();
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Arm the debounced save. Per-schedule handle capture: the callback only
   * clears its OWN handle, so an orphaned/overwritten timer can never null a
   * newer timer's slot and leave it uncancellable. */
  private scheduleDebounce(): void {
    // The single choke point for arming a save. A disposed coordinator arms
    // nothing — from a caller, a retry, or an in-flight save's finally-block
    // re-arm — which is what makes "disposal is final" true rather than just
    // documented (H3-2).
    if (this.disposed) return;
    const timer = window.setTimeout(() => {
      if (this.debounceTimer === timer) this.debounceTimer = null;
      void this.trySave();
    }, SAVE_DELAY_MS);
    this.debounceTimer = timer;
  }

  private scheduleRetry(): void {
    const timer = window.setTimeout(() => {
      if (this.retryTimer === timer) this.retryTimer = null;
      void this.trySave();
    }, SAVE_DELAY_MS);
    this.retryTimer = timer;
  }
}
