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

export interface SaveCoordinatorOptions {
  /** Supplies the active store per call, so a mode change is picked up. */
  getStore: () => DraftStore | null;
  /** Routes save failures to the component's error surface. */
  onError(err: unknown): void;
}

interface SavePayload {
  draft: string;
  notes: Note[];
}

export class SaveCoordinator {
  private readonly options: SaveCoordinatorOptions;
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
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.trySave();
    }, SAVE_DELAY_MS);
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
   */
  async trySave(): Promise<void> {
    this.clearTimers();
    if (this.pending === null || this.inFlight) return;
    const payload = this.pending;
    const isRetry = this.retryScheduled;
    this.retryScheduled = false;
    this.inFlight = true;
    try {
      await this.store?.save(payload.draft, payload.notes);
      if (this.pending === payload) this.pending = null;
    } catch (err) {
      if (isRetry) {
        this.options.onError(err);
      } else {
        this.retryScheduled = true;
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          void this.trySave();
        }, SAVE_DELAY_MS);
      }
    } finally {
      this.inFlight = false;
      // A newer payload arrived while this save ran: don't swallow it —
      // re-arm the debounce so it still gets persisted.
      if (this.pending !== null && this.pending !== payload) {
        this.debounceTimer = window.setTimeout(() => {
          this.debounceTimer = null;
          void this.trySave();
        }, SAVE_DELAY_MS);
      }
    }
  }

  /**
   * Force an immediate save (tab hidden / page unloading). Failures surface
   * via onError and keep the payload — the next edit() re-arms.
   */
  async flush(opts?: { keepalive?: boolean }): Promise<void> {
    this.clearTimers();
    this.retryScheduled = false;
    if (this.pending === null || this.inFlight) return;
    const payload = this.pending;
    this.inFlight = true;
    try {
      await this.store?.save(payload.draft, payload.notes, opts);
      if (this.pending === payload) this.pending = null;
    } catch (err) {
      this.options.onError(err);
    } finally {
      this.inFlight = false;
      if (this.pending !== null && this.pending !== payload) {
        this.debounceTimer = window.setTimeout(() => {
          this.debounceTimer = null;
          void this.trySave();
        }, SAVE_DELAY_MS);
      }
    }
  }

  /** Cancel pending timers (component unmount). */
  dispose(): void {
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
}
