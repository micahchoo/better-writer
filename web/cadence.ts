/**
 * cadence: when is a draft "ready" for a coaching question?
 *
 * The coach should not pester a writer mid-flow. A question only becomes
 * worth asking once the draft has grown by a real amount AND the writer has
 * stopped editing for a beat — so the question lands in a pause, not across
 * their keystrokes.
 *
 * Cadence is a pure, side-effect-free state machine. The caller feeds it the
 * current draft on every content change and on a periodic tick; it answers
 * with a phase. The caller owns all side effects (firing a question, timers):
 * `observe` only reads and records.
 *
 * State is derived from two facts:
 *   baseline   — the word count at which the current question-cycle armed.
 *   lastEditAt — when the most recent real edit happened.
 * A "real edit" is a change in word count. A tick that re-feeds identical
 * text (same word count) is not an edit and must not move lastEditAt —
 * otherwise a polling loop would silently reset the pause forever.
 */

import { countProseWords } from './window-stats.js';

export const WORD_THRESHOLD = 30;
export const PAUSE_MS = 20_000;

export type CadencePhase = 'idle' | 'armed' | 'ready';

export interface Cadence {
  /** Feed the current draft on every content change and on a periodic tick.
   * Transitions: baseline unset -> arms at current word count ('idle').
   * Net-new words < threshold -> 'armed'. Threshold met AND no edit for
   * PAUSE_MS -> 'ready'. Pure: never fires side effects. */
  observe(text: string, now?: number): CadencePhase;
  /** Re-arm at the current word count (after firing a question). */
  reset(text: string, now?: number): void;
}

export function createCadence(opts?: {
  threshold?: number;
  pauseMs?: number;
}): Cadence {
  const threshold = opts?.threshold ?? WORD_THRESHOLD;
  const pauseMs = opts?.pauseMs ?? PAUSE_MS;

  let baseline: number | null = null;
  let lastWordCount: number | null = null;
  let lastEditAt = 0;

  /**
   * Word count: PROSE words, via window-stats' own counter. Cadence gates an
   * interruption, so it must not be tripped by markdown scaffolding — `##`,
   * `**`, bullets and `---` are not new prose (H1-5). Sharing the counter is
   * what keeps the two modules from disagreeing about what a word is.
   */
  const words = (text: string): number => countProseWords(text);

  return {
    observe(text: string, now: number = Date.now()): CadencePhase {
      const count = words(text);

      // First feed: no baseline yet, so arm here and report 'idle'. This is
      // a content change (the cycle's opening edit) and anchors lastEditAt.
      if (baseline === null) {
        baseline = count;
        lastWordCount = count;
        lastEditAt = now;
        return 'idle';
      }

      // A word-count change marks a real edit and restarts the pause clock;
      // an unchanged tick must leave lastEditAt alone (see module note).
      if (count !== lastWordCount) {
        lastEditAt = now;
        lastWordCount = count;
      }

      const netNew = count - baseline;
      // Not enough new prose yet — stay armed, regardless of elapsed time.
      if (netNew < threshold) return 'armed';
      // Threshold met: only 'ready' once the writer has been quiet long enough.
      if (now - lastEditAt >= pauseMs) return 'ready';
      return 'armed';
    },

    reset(text: string, now: number = Date.now()): void {
      // Re-arm after firing a question: the current count becomes the new
      // baseline and the pause clock restarts from this moment.
      baseline = words(text);
      lastWordCount = baseline;
      lastEditAt = now;
    },
  };
}
