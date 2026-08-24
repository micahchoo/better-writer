/**
 * save-indicator: the debounced save-status display state machine behind
 * EditorApp's topbar pulse.
 *
 * The coordinator reports raw lifecycle events ('saving' on send, 'saved' on
 * confirmed persist). This layer turns those into a flicker-free display
 * label so a typing burst never strobes the indicator per save:
 *   - 'Saving…' appears ONLY if a save is still unconfirmed 400ms after it
 *     began — a fast save never flashes the label.
 *   - 'Saved' stays sticky for 1500ms after confirmation, then reverts to
 *     idle.
 *   - A failed save clears any in-flight 'Saving…' back to idle so the
 *     indicator never sticks; the failure affordance itself is the app's
 *     error toast, driven by the coordinator's onError.
 * Rapid queued saves never flicker: the pending 'Saving…' timer is cancelled
 * the moment a save confirms, so a burst stays on 'Saved' the whole time, and
 * a new confirmation re-arms the sticky window without dropping to idle.
 */

export type SaveIndicatorDisplay = 'idle' | 'saving' | 'saved';

/** How long a save may run before 'Saving…' is worth showing. */
export const SAVE_PENDING_MS = 400;
/** How long 'Saved' stays visible before reverting to idle. */
export const SAVE_STICKY_MS = 1500;

export class SaveIndicator {
  private display: SaveIndicatorDisplay = 'idle';
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private stickyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onDisplay: (display: SaveIndicatorDisplay) => void;

  constructor(onDisplay: (display: SaveIndicatorDisplay) => void) {
    this.onDisplay = onDisplay;
  }

  /** Coordinator 'saving' phase: a save is in flight. */
  saveStarted(): void {
    this.clearTimers();
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      // Only surface 'Saving…' if the save is still unconfirmed when the
      // pending window elapses — a fast save never shows it.
      this.setDisplay('saving');
    }, SAVE_PENDING_MS);
  }

  /** Coordinator 'saved' phase: the latest save was confirmed. */
  saveSucceeded(): void {
    this.clearTimers();
    this.setDisplay('saved');
    this.stickyTimer = setTimeout(() => {
      this.stickyTimer = null;
      this.setDisplay('idle');
    }, SAVE_STICKY_MS);
  }

  /** Coordinator onError: a save failed to land. Clears any in-flight
   * 'Saving…' so the indicator never sticks on it; the failure affordance is
   * the app's error toast, which the coordinator's onError already drives. */
  saveFailed(): void {
    this.clearTimers();
    this.setDisplay('idle');
  }

  /** Cancel pending timers (component unmount). */
  dispose(): void {
    this.clearTimers();
  }

  private setDisplay(display: SaveIndicatorDisplay): void {
    if (this.display === display) return;
    this.display = display;
    this.onDisplay(display);
  }

  private clearTimers(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    if (this.stickyTimer !== null) {
      clearTimeout(this.stickyTimer);
      this.stickyTimer = null;
    }
  }
}
