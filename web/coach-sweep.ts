/** Plan section-bounded windows and deliver grounded coaching notes in plan order. */

import { extractAnchor } from './anchor.js';
import { buildAskWindow, cursorWindow, partitionSections, splitBlocks, THEMATIC_BREAK_RE } from '../src/core/text-window.js';
import type { Block } from '../src/core/text-window.js';
import type { Coach, Genre, QuestionSource } from '../src/core/types.js';

/** Blocks per window: 3; a trailing group of fewer than 3 blocks merges into
 * the previous window when the budget allows (Q4). */
const WINDOW_BLOCKS = 3;

/** Character budget for a planned window's projected marked length; a block
 * that alone exceeds it is still emitted as its own (oversized) window. */
const MAX_WINDOW_CHARS = 1200;

export { reconcileAnnotations, staleAnnotations, type AnchorRecordLike } from './annotations.js';

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
  /** Provenance carried by the individual coach result. */
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
  /** Calls dispatched, including those canceled while in flight. */
  requested: number;
  /** Completed results reporting an unavailable coach. */
  unavailable: number;
  /** Completed results explicitly declining all candidates. */
  noFit: number;
  /** Completed results whose bounded output validation failed. */
  invalid: number;
  /** Question results rejected by local evidence validation. */
  unanchored: number;
}

/** One planned window of a sweep, ready for Coach.ask. */
export interface SweepWindowPlan {
  /** Legacy marked representation for experiments; requests use textWindow. */
  markedText: string;
  /** Contiguous, unmodified draft text. */
  textWindow: string;
  focus: { start: number; end: number };
  position: { sectionBlockCount: number; blockIndexInSection: number };
  /** offset of the marked middle block's midpoint in the full draft — the
   * anchor hint used for static seeds and cursorOffset in the request. */
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

  return windows.map(({ blocks: windowBlocks, section }) => {
    // One derivation of the marked block — the middle, or the earlier of
    // the two middles on an even count — feeds BOTH the wire format and the
    // cursorHint, so they can never disagree about where the ask anchors.
    const middle = windowBlocks.length % 2 === 1 ? Math.floor(windowBlocks.length / 2) : windowBlocks.length / 2 - 1;
    return windowPlan(markdown, windowBlocks, middle, sections[section]);
  });
}

function windowPlan(markdown: string, blocks: Block[], middle: number, section: Block[]): SweepWindowPlan {
  const marked = blocks[middle];
  const start = blocks[0].start;
  const end = blocks[blocks.length - 1].end;
  return {
    textWindow: markdown.slice(start, end),
    focus: { start: marked.start - start, end: marked.end - start },
    position: { sectionBlockCount: section.length, blockIndexInSection: section.indexOf(marked) },
    markedText: buildAskWindow(blocks.map(block => block.text), middle),
    cursorHint: marked.start + Math.floor((marked.end - marked.start) / 2),
    bounds: { start, end },
  };
}

/** Cursor-centered raw window, clipped to the actual containing section. */
export function cursorPlan(markdown: string, cursorOffset: number): SweepWindowPlan | null {
  const blocks = splitBlocks(markdown);
  if (!blocks.length) return null;
  const marked = blocks.find(block => cursorOffset >= block.start && cursorOffset <= block.end)
    ?? blocks.find(block => block.start >= cursorOffset) ?? blocks[blocks.length - 1];
  if (isThematicBreak(marked)) return null;
  const section = partitionSections(blocks).find(section => section.includes(marked))!;
  const prose = section.filter(block => !isThematicBreak(block));
  const selected = cursorWindow(prose, cursorOffset)!;
  const center = prose.indexOf(marked);
  const from = center - selected.markIndex;
  return windowPlan(markdown, prose.slice(from, from + selected.texts.length), selected.markIndex, section);
}

/** Each result carries its own provenance and verified evidence. On stop or
 * failure the controller aborts siblings; stale continuations cannot emit. */
export async function runSweep(
  plan: SweepWindowPlan[],
  opts: {
    genre: Genre;
    coach: Coach;
    draft: string;
    onNote(note: SweepNote): void;
    onProgress?(done: number, total: number): void;
    shouldAbort?(): boolean;
    signal?: AbortSignal;
  },
): Promise<SweepResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  const notes: SweepNote[] = [];
  const byIndex: Array<SweepNote | undefined> = new Array(plan.length);
  const resolved = new Array<boolean>(plan.length).fill(false);
  let drained = 0;
  let next = 0;
  const counts = { requested: 0, unavailable: 0, noFit: 0, invalid: 0, unanchored: 0 };
  let active = true;
  const stopped = () => {
    if (opts.shouldAbort?.()) abort();
    return !active || controller.signal.aborted;
  };
  function drain(): void {
    while (!stopped() && drained < plan.length && resolved[drained]) {
      const note = byIndex[drained++];
      if (note) {
        notes.push(note);
        opts.onNote(note);
      }
      if (!stopped()) opts.onProgress?.(drained, plan.length);
    }
  }
  const worker = async () => {
    while (!stopped() && next < plan.length) {
      const index = next++;
      const window = plan[index];
      counts.requested++;
      const result = await opts.coach.ask({
        textWindow: window.textWindow,
        focus: window.focus,
        position: window.position,
        cursorOffset: window.cursorHint,
        genre: opts.genre,
      }, controller.signal);
      if (stopped()) return;
      if (result.kind === 'unavailable') counts.unavailable++;
      if (result.kind === 'skip') {
        if (result.reason === 'no-fit') counts.noFit++; else counts.invalid++;
      }
      if (result.kind === 'question') {
        const evidence = result.evidence;
        // Reshaped results may only use the server-validated evidence span.
        // Static seeds can retain the legacy literal-quote anchoring behavior.
        const anchor = evidence
          ? Number.isInteger(evidence.start) && Number.isInteger(evidence.end) &&
            evidence.start >= window.focus.start && evidence.end <= window.focus.end &&
            evidence.end > evidence.start && result.question.includes(evidence.quote) &&
            evidence.end <= window.textWindow.length &&
            window.textWindow.slice(evidence.start, evidence.end) === evidence.quote
              ? { start: window.bounds.start + evidence.start,
                  end: window.bounds.start + evidence.end, fragment: evidence.quote }
              : null
          : result.source === 'seed' ? extractAnchor(result.question, opts.draft, window.cursorHint) : null;
        if (anchor && anchor.start >= window.bounds.start && anchor.end <= window.bounds.end &&
            opts.draft.slice(anchor.start, anchor.end) === anchor.fragment) {
          byIndex[index] = { ...anchor, question: result.question, source: result.source,
            windowIndex: index, ts: Date.now() };
        } else counts.unanchored++;
      }
      resolved[index] = true;
      drain();
    }
  };
  // Race cancellation so even an adapter that ignores AbortSignal cannot
  // hold the owner's lifecycle open. Promise.all still observes late errors.
  let removeAbort = () => {};
  const canceled = new Promise<void>((resolve) => {
    const listener = () => resolve();
    controller.signal.addEventListener('abort', listener, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', listener);
    if (controller.signal.aborted) resolve();
  });
  try {
    await Promise.race([
      Promise.all(Array.from({ length: Math.min(2, plan.length) }, worker)),
      canceled,
    ]);
    return { notes, asked: notes.length, skipped: plan.length - notes.length, ...counts };
  } catch (error) {
    abort();
    throw error;
  } finally {
    active = false;
    removeAbort();
    opts.signal?.removeEventListener('abort', abort);
  }
}
