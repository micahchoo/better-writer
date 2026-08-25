/**
 * coach-sweep: the "sweep" mode — read the WHOLE draft in non-overlapping
 * windows and ask the coach once per window, leaving one pinned annotation
 * per window.
 *
 * Windows never span section boundaries (a heading or thematic break starts
 * a new section — partitionSections), and grow up to 3 blocks or
 * MAX_WINDOW_CHARS of projected marked length, whichever binds first. A
 * trailing group of fewer than 3 blocks merges into the previous window —
 * adding at most one block past the cap, so a merged tail may hold
 * WINDOW_BLOCKS + 1 — when the result stays within budget and within one
 * section; an over-budget block is emitted as its own oversized window
 * rather than split. Each window is marked with [CURSOR START]/[CURSOR END] around its
 * MIDDLE block (the earlier of the two middles when the window has an even
 * block count), so the server's gate sees a small envelope for the question
 * to anchor to.
 *
 * Windows are asked through a small fixed-size worker pool (at most two in
 * flight at once, so a long draft doesn't hammer the local model), and each
 * note is reported to the caller as soon as its window resolves (via the
 * onNote callback) — strictly in plan order, never overtaking an earlier,
 * still-pending window. A note is only emitted when the coach's answer
 * anchors INSIDE its own window's block bounds; answers that anchor nowhere
 * or elsewhere in the draft are logged and skipped (never an unanchored,
 * garbage note).
 *
 * On the first failing ask the sweep rejects mid-way and latches an abort:
 * no worker claims a new window, so any ask already in flight (at most one
 * window-slot's worth, alongside the failure) completes but nothing further
 * is spent. Notes from windows that completed are still delivered — the
 * failed window's slot is marked resolved so the drain prefix advances past
 * it — and the failed window itself yields nothing.
 */

import { extractAnchor } from './anchor.js';
import type { AnchorRecord } from './draft-store.js';
import { buildAskWindow, partitionSections, splitBlocks, THEMATIC_BREAK_RE } from './text-window.js';
import type { Block } from './text-window.js';
import type { Genre, QuestionSource } from '../src/types.js';

/** Blocks per window: 3; a trailing group of fewer than 3 blocks merges into
 * the previous window when the budget allows (Q4). */
const WINDOW_BLOCKS = 3;

/** Character budget for a planned window's projected marked length; a block
 * that alone exceeds it is still emitted as its own (oversized) window. */
const MAX_WINDOW_CHARS = 1200;

/**
 * The anchor-shape staleAnnotations consumes: the span + fragment subset of
 * an AnchorRecord, so persisted annotations pass through directly.
 */
export type AnchorRecordLike = Pick<AnchorRecord, 'start' | 'end' | 'fragment'> & {
  /** Optional neighbourhood captured at mint time; disambiguates duplicates (H9-1). */
  context?: { before: string; after: string };
};

/** A single sweep annotation, ready to persist alongside single annotations. */
export interface SweepNote {
  /** anchor start offset in the full draft */
  start: number;
  /** anchor end offset (exclusive) in the full draft */
  end: number;
  /** draft text covered by the anchor */
  fragment: string;
  /** the coach's question this note came from */
  question: string;
  /** index of the window in the sweep plan this note came from */
  windowIndex: number;
  /** epoch ms when the note was created */
  ts: number;
  /** How the question's text was produced (read from the coach after the
   * ask); absent for a static pick or a legacy persisted note. */
  source?: QuestionSource;
}

/** The outcome of a whole sweep: the anchored notes plus a progress tally
 * whose two counters always cover the plan (asked + skipped === plan.length). */
export interface SweepResult {
  /** every note that anchored inside its window, in plan order */
  notes: SweepNote[];
  /** windows whose ask produced an anchored note */
  asked: number;
  /** windows that produced no note — an answer that failed to anchor, or a
   * window never started because the sweep aborted */
  skipped: number;
}

/** One planned window of a sweep, ready for Coach.ask. */
export interface SweepWindowPlan {
  /** marked text_window payload for Coach.ask (markers around the middle block) */
  markedText: string;
  /** offset of the marked middle block's midpoint in the full draft — the
   * anchor hint runSweep hands extractAnchor (Q6). The window's first
   * character — the cursor_offset /ask receives — is bounds.start. */
  cursorHint: number;
  /** this window's own block span in the full draft: first block start
   * through last block end. Consumed directly by runSweep's containment
   * check, so grouping is never re-derived (Q6). */
  bounds: { start: number; end: number };
}


/** The projected marked length of a block group once formed into a window:
 * block texts joined by 2-char blank lines (n−1 separators) plus the 28
 * characters a marked window adds — both marker tokens and their two
 * surrounding newlines. Used as the budget proxy (Q2); a single block
 * over the budget still becomes its own window (Q3).
 */
/** A `---`/`***`/`___` rule: a separator, never prose to ask about (H9-2). */
function isThematicBreak(block: Block): boolean {
  return THEMATIC_BREAK_RE.test(block.text.trim());
}

function projectedMarkedLength(blocks: Block[]): number {
  const textLength = blocks.reduce((sum, block) => sum + block.text.length, 0);
  return textLength + 2 * (blocks.length - 1) + 28;
}

/**
 * Plan all windows for a draft: partition the blocks into sections (a
 * heading or thematic break starts a new section — Q1), then per section
 * greedily group consecutive blocks into windows that stop growing at
 * WINDOW_BLOCKS blocks OR when adding the next block would push the
 * projected marked length past MAX_WINDOW_CHARS (Q2). A trailing group of
 * fewer than 3 blocks merges into the previous window when the merge stays
 * within budget, within the same section, and keeps the merged window at or
 * under WINDOW_BLOCKS + 1 blocks (Q4); an over-budget block is emitted as
 * its own oversized window (Q3). Each window's middle block is
 * marked with cursor markers, and the plan carries a cursorHint at the
 * marked block's midpoint plus the window's own block bounds (Q6).
 * Empty document -> empty plan.
 *
 * @param markdown the full draft markdown
 * @returns one plan entry per window, in document order
 */
export function planSweep(markdown: string): SweepWindowPlan[] {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) return [];

  // Group greedily inside each section so no window spans a boundary. Track
  // the owning section index so the tail merge can refuse a cross-section
  // bridge (Q1).
  const windows: Array<{ blocks: Block[]; section: number }> = [];
  const sections = partitionSections(blocks);
  sections.forEach((section, sectionIndex) => {
    let current: Block[] = [];
    // A thematic break is a SEPARATOR, not prose. partitionSections already
    // uses it to start a section, but splitBlocks also keeps it as a
    // first-class paragraph, so it could become a window's marked block —
    // "[CURSOR START]\n---\n[CURSOR END]" — or, at the end of a draft, a
    // whole window whose entire content is "---". Such a window has no
    // quotable words, so the ask fails isGrounded, spends the retry and falls
    // back to a topic probe, costing a token in byok for nothing (H9-2).
    for (const block of section.filter((b) => !isThematicBreak(b))) {
      if (current.length === 0) {
        current = [block];
        continue;
      }
      const candidate = [...current, block];
      if (current.length >= WINDOW_BLOCKS || projectedMarkedLength(candidate) > MAX_WINDOW_CHARS) {
        windows.push({ blocks: current, section: sectionIndex });
        current = [block];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) windows.push({ blocks: current, section: sectionIndex });
  });

  // Q4 post-pass: a final group of fewer than 3 blocks merges into the
  // previous window unless the merge would overrun the budget or bridge two
  // sections; otherwise the stub stands alone.
  const last = windows[windows.length - 1];
  if (windows.length >= 2 && last.blocks.length < WINDOW_BLOCKS) {
    const prev = windows[windows.length - 2];
    if (prev.section === last.section) {
      const merged = [...prev.blocks, ...last.blocks];
      // Block-count test too: the greedy pass caps a normal window at
      // WINDOW_BLOCKS, and the merge may fold in at most one extra block
      // (WINDOW_BLOCKS + 1) — never a 2-block stub onto an already-full
      // 3-block window, which would make a 5-block window. Character budget
      // alone cannot stop that.
      if (merged.length <= WINDOW_BLOCKS + 1 && projectedMarkedLength(merged) <= MAX_WINDOW_CHARS) {
        prev.blocks = merged;
        windows.pop();
      }
    }
  }

  return windows.map(({ blocks: windowBlocks }) => {
    // One derivation of the marked block — the middle, or the earlier of
    // the two middles on an even count — feeds BOTH the wire format and the
    // cursorHint, so they can never disagree about where the ask anchors.
    const middle = windowBlocks.length % 2 === 1 ? Math.floor(windowBlocks.length / 2) : windowBlocks.length / 2 - 1;
    const marked = windowBlocks[middle];
    return {
      markedText: buildAskWindow(windowBlocks.map((block) => block.text), middle),
      cursorHint: marked.start + Math.floor(marked.text.length / 2),
      bounds: { start: windowBlocks[0].start, end: windowBlocks[windowBlocks.length - 1].end },
    };
  });
}

/**
 * Run a sweep over an already-planned list. Windows are asked through a small
 * fixed-size worker pool (at most two asks in flight at once, so a long draft
 * doesn't hammer the local model), and notes are reported via onNote strictly
 * in ascending windowIndex order: each window's outcome is parked in a slot
 * indexed by windowIndex, and after any resolution the consecutive completed
 * prefix is drained and emitted, so a later-resolving window never overtakes
 * an earlier still-pending one.
 *
 * After each ask, the question is anchored with extractAnchor using the
 * window's cursorHint (the marked block's midpoint). When the answer does
 * not anchor anywhere (extractAnchor returns null) or the anchor lands
 * OUTSIDE the window's own planned block bounds (a quote from elsewhere in
 * the draft), the note is logged and skipped — a sweep never emits an
 * unanchored or out-of-window annotation.
 *
 * Aborting is a normal exit, not a failure: shouldAbort() is consulted before
 * STARTING each window; windows already in flight complete and are processed
 * normally, then no further window is started. Throwing is reserved for
 * coach.ask itself: a failing ask rejects the sweep mid-way and latches an
 * abort, so no further window is claimed — the only asks still issued are
 * ones already in flight, within one window-slot. Notes from windows that
 * completed are still delivered: the failed window's slot is marked resolved
 * so the drain prefix advances past it, and the failed window yields nothing.
 *
 * The returned SweepResult's counters are exhaustive: `asked` is the number of
 * windows that produced an anchored note, and `skipped` is every other window
 * (an answer that failed to anchor, or a window never started due to abort),
 * so asked + skipped === plan.length always.
 *
 * @param plan the windows to ask, in document order
 * @param opts genre, the coach seam, the full draft, and the onNote callback;
 *   optionally onProgress (fired with the completed window count and the
 *   plan length after each window resolves — asked or skipped) and shouldAbort
 *   (consulted before starting each window; true stops starting new ones)
 * @returns the anchored notes in plan order plus the asked/skipped tally
 */
export async function runSweep(
  plan: SweepWindowPlan[],
  opts: {
    genre: Genre;
    coach: {
      ask(textWindow: string, genre: Genre, cursorOffset: number): Promise<string>;
      /** Provenance of the most recent ask; null for the static coach or
       * before any ask. Optional so a legacy inline coach shape (bare ask
       * only) still satisfies the seam and simply yields notes with no
       * source. */
      lastSource?(): QuestionSource | null;
    };
    draft: string;
    onNote(note: SweepNote): void;
    onProgress?(done: number, total: number): void;
    shouldAbort?(): boolean;
  },
): Promise<SweepResult> {
  // Each window's outcome is parked in a slot keyed by its windowIndex; a
  // slot is flagged resolved once its ask returns, and the consecutive
  // completed prefix is drained so notes always reach the caller in plan
  // order no matter which window's ask resolved first. A window whose answer
  // failed to anchor parks no note but still marks its slot resolved, so a
  // later window can never be emitted before that earlier gap closes.
  const notes: SweepNote[] = [];
  const byIndex: Array<SweepNote | undefined> = new Array(plan.length);
  const resolved = new Array<boolean>(plan.length).fill(false);
  let drained = 0;
  // Abort latch set on the first failing ask (distinct from the caller's
  // shouldAbort, which is the graceful Stop-button path and resolves the
  // sweep normally). Once set, no worker claims another window.
  let failed = false;

  function drain(): void {
    while (drained < plan.length && resolved[drained]) {
      const note = byIndex[drained];
      if (note) {
        notes.push(note);
        opts.onNote(note);
      }
      drained++;
      opts.onProgress?.(drained, plan.length);
    }
  }

  async function processWindow(index: number): Promise<void> {
    const window = plan[index];
    // /ask returns decoded prose: the server strips marker tokens before the gate.
    const question = await opts.coach.ask(window.markedText, opts.genre, window.bounds.start);
    // Read provenance immediately after the ask resolves, before any other
    // in-flight ask could overwrite the coach's lastSource.
    const source = opts.coach.lastSource?.() ?? undefined;

    const anchor = extractAnchor(question, opts.draft, window.cursorHint);
    const bounds = window.bounds;
    if (anchor !== null && anchor.start >= bounds.start && anchor.end <= bounds.end) {
      byIndex[index] = {
        start: anchor.start,
        end: anchor.end,
        fragment: anchor.fragment,
        question,
        windowIndex: index,
        ts: Date.now(),
        // source is optional; only set it when the coach reported one.
        ...(source !== undefined ? { source } : {}),
      };
    } else {
      console.warn(
        `[coach-sweep] skipping window ${index}: the coach's answer did not anchor inside the window bounds`,
      );
    }
    resolved[index] = true;
    drain();
  }

  // A fixed-size worker pool: at most POOL_SIZE asks in flight at once. Each
  // worker takes the next window via a shared counter and awaits its own ask
  // before looping, so a single worker never fans out more asks than it can
  // hold. The abort latch is consulted BEFORE claiming a window; a worker
  // already awaiting an ask lets it finish and process normally, then stops.
  const POOL_SIZE = 2;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (failed || opts.shouldAbort?.()) return;
      const index = next++;
      if (index >= plan.length) return;
      try {
        await processWindow(index);
      } catch (err) {
        // Latch the abort so no sibling worker claims another window (the
        // only asks still issued are ones already in flight, at most one
        // window-slot's worth), then mark this slot resolved so drain()'s
        // consecutive-prefix pointer can advance past the failed window and
        // still emit notes that later windows resolved. The failure itself
        // yields nothing; it propagates and rejects the whole sweep.
        failed = true;
        resolved[index] = true;
        drain();
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(POOL_SIZE, plan.length) }, () => worker()));

  return { notes, asked: notes.length, skipped: plan.length - notes.length };
}

/**
 * Reconcile the current annotation list against a draft: validate (and
 * re-anchor, see staleAnnotations), then report whether ANY entry changed —
 * dropped entries shrink the list; remapped entries are fresh objects while
 * untouched entries keep their identity.
 *
 * Consumers must branch on `changed`, not on length alone: a pure remap keeps
 * the count identical, so a length-only check silently discards the new
 * offsets and persists the stale spans instead.
 *
 * @param current the annotation list as last stored
 * @param draft the draft text after the latest edit
 * @returns the surviving list plus whether the caller must adopt it
 */
export function reconcileAnnotations<T extends AnchorRecordLike>(
  current: T[],
  draft: string,
): { valid: T[]; changed: boolean } {
  const valid = staleAnnotations(current, draft) as T[];
  return {
    valid,
    changed:
      valid.length !== current.length || valid.some((a, i) => a !== current[i]),
  };
}

/**
 * Validate annotations against the draft, re-anchoring instead of dropping
 * where possible. An annotation survives when either:
 * - its fragment still sits exactly at its recorded offsets, or
 * - its fragment appears elsewhere intact (an upstream edit shifted the
 *   offsets without touching the anchored text) — the annotation is remapped
 *   to the occurrence NEAREST its old position.
 *
 * An annotation is dropped only when its fragment no longer exists in the
 * draft, is empty, or has two occurrences equidistant from the old position
 * (remapping would guess).
 *
 * @param annotations persisted annotations to check
 * @param draft the current draft markdown
 * @returns the surviving annotations (moved ones on fresh offset objects),
 *   in input order
 */
/** Length of the longest common suffix of two strings. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the longest common prefix of two strings. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export function staleAnnotations(annotations: AnchorRecordLike[], draft: string): AnchorRecordLike[] {
  return annotations.flatMap((annotation) => {
    // Drop degenerate spans up front: an empty fragment or a zero-length span
    // is invisible (buildHighlightSet requires start < end) yet would
    // otherwise survive the exact-offset check below and ride every save.
    if (!annotation.fragment || annotation.start >= annotation.end) return [];
    if (
      annotation.start >= 0 &&
      annotation.end <= draft.length &&
      draft.slice(annotation.start, annotation.end) === annotation.fragment
    ) {
      return [annotation];
    }
    const occurrences: number[] = [];
    for (
      let idx = draft.indexOf(annotation.fragment);
      idx !== -1;
      idx = draft.indexOf(annotation.fragment, idx + 1)
    ) {
      occurrences.push(idx);
    }
    if (occurrences.length === 0) return [];

    // More than one occurrence: distance from the STALE ABSOLUTE start is the
    // wrong discriminator. A pure insertion before both shifts every
    // occurrence equally, so the earlier duplicate becomes "nearest" and the
    // writer's pinned highlight jumps to a different identical sentence
    // (H9-1). Context — the text that was AROUND this span when the note was
    // minted — survives that shift, so it decides when it is available.
    if (occurrences.length > 1 && annotation.context) {
      const { before, after } = annotation.context;
      let ctxBest = -1;
      let ctxScore = -1;
      let ctxTied = false;
      for (const idx of occurrences) {
        const seenBefore = draft.slice(Math.max(0, idx - before.length), idx);
        const seenAfter = draft.slice(idx + annotation.fragment.length).slice(0, after.length);
        const score = commonSuffix(before, seenBefore) + commonPrefix(after, seenAfter);
        if (score > ctxScore) {
          ctxScore = score;
          ctxBest = idx;
          ctxTied = false;
        } else if (score === ctxScore) {
          ctxTied = true;
        }
      }
      // A tie means the context cannot tell them apart either (identical
      // neighbourhoods); fall through to distance rather than guess.
      if (ctxBest !== -1 && !ctxTied && ctxScore > 0) {
        return [
          {
            ...annotation,
            start: ctxBest,
            end: ctxBest + annotation.fragment.length,
          },
        ];
      }
    }

    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    let tied = false;
    for (const idx of occurrences) {
      const dist = Math.abs(idx - annotation.start);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
        tied = false;
      } else if (dist === bestDist) {
        tied = true;
      }
    }
    if (best === -1 || tied) return [];
    return [{ ...annotation, start: best, end: best + annotation.fragment.length }];
  });
}
