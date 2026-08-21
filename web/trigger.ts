/**
 * trigger: the word-count AskTrigger.
 *
 * Fires when 30 net-new words have been typed since the last fire; firing
 * resets the counter. "Net" means deletions subtract — `onWordsAdded` accepts
 * negative deltas and never fires on zero or less.
 *
 * Idle-gate contract for the caller: automatic asks must ALSO pass
 * `shouldFire(now)` — at least ASK_IDLE_MS (2s) since the last fire — so a
 * question never pops up on top of the previous one. Typical use:
 *
 *   if (trigger.shouldFire(Date.now()) && trigger.onWordsAdded(delta)) {
 *     void askNow();   // fires and resets the counter
 *   }
 *
 * Manual asks are always allowed and go through `manualAsk()`, which resets
 * the word counter and re-arms the idle gate so the next automatic fire
 * counts fresh words from that moment.
 */

export const ASK_WORD_THRESHOLD = 30;
export const ASK_IDLE_MS = 2000;

export interface AskTriggerOptions {
  /** Clock for fire timestamps; injectable for deterministic tests. */
  now?: () => number;
}

export class AskTrigger {
  private readonly now: () => number;
  private words = 0;
  /** Timestamp of the last fire; null until the first fire (gate open). */
  private lastFireAt: number | null = null;

  constructor(options: AskTriggerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** How many net words have accumulated since the last fire. */
  get pendingWords(): number {
    return this.words;
  }

  /**
   * Accumulate `deltaWords` net-new words. Returns true (and resets the
   * counter) once the accumulated total reaches ASK_WORD_THRESHOLD. Never
   * fires on a zero or negative delta.
   */
  onWordsAdded(deltaWords: number): boolean {
    if (!Number.isFinite(deltaWords) || deltaWords <= 0) return false;
    this.words += deltaWords;
    if (this.words >= ASK_WORD_THRESHOLD) {
      this.words = 0;
      this.lastFireAt = this.now();
      return true;
    }
    return false;
  }

  /**
   * Idle gate: true once at least ASK_IDLE_MS has passed since the last fire
   * (word-count or manual). A trigger that has never fired is armed.
   */
  shouldFire(now: number = this.now()): boolean {
    return this.lastFireAt === null || now - this.lastFireAt >= ASK_IDLE_MS;
  }

  /** Record a manual ask: resets the word counter and re-arms the idle gate. */
  manualAsk(): void {
    this.words = 0;
    this.lastFireAt = this.now();
  }
}
