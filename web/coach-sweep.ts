/**
 * coach-sweep: the "sweep" mode — read the WHOLE draft in non-overlapping
 * windows and ask the coach once per window, leaving one pinned annotation
 * per window.
 *
 * Window = 3 consecutive blocks (the same Block split text-window's
 * splitBlocks produces), stride = 3; a tail of fewer than 3 blocks merges
 * into the last window instead of spawning a stub window. Each window is
 * marked with [CURSOR START]/[CURSOR END] around its MIDDLE block (the
 * earlier of the two middles when the window has an even block count), so
 * the server's gate sees a small envelope for the question to anchor to.
 *
 *
 * Execution is strictly serialized — one coach.ask at a time — and each
 * note is reported to the caller as soon as its own ask resolves (via the
 * onNote callback), so annotations appear progressively. A note is only
 * emitted when the coach's answer anchors INSIDE its own window's block
 * bounds; answers that anchor nowhere or elsewhere in the draft are
 * logged and skipped (never an unanchored, garbage note).
 */

import { extractAnchor } from './anchor.js';
import type { AnchorRecord } from './draft-store.js';
import { splitBlocks } from './text-window.js';
import type { Genre } from '../src/types.js';

const CURSOR_START = '[CURSOR START]';
const CURSOR_END = '[CURSOR END]';

/** Blocks per window: 3, with a tail of fewer than 3 absorbed into the last window. */
const WINDOW_BLOCKS = 3;

/** A block, structurally — text-window's Block is not exported. */
interface BlockLike {
  text: string;
  start: number;
  end: number;
  kind: 'paragraph' | 'list-item' | 'heading';
}

/**
 * The anchor-shape staleAnnotations consumes: the span + fragment subset of
 * an AnchorRecord, so persisted annotations pass through directly.
 */
export type AnchorRecordLike = Pick<AnchorRecord, 'start' | 'end' | 'fragment'>;

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
}

/** One planned window of a sweep, ready for Coach.ask. */
export interface SweepWindowPlan {
  /** marked text_window payload for Coach.ask (markers around the middle block) */
  markedText: string;
  /** first character offset of this window in the full draft */
  startOffset: number;
}

/**
 * Join a window's blocks with blank lines, wrapping its middle block in
 * [CURSOR START]/[CURSOR END] (the earlier of the two middles on an even
 * block count), matching text-window's marker formatting.
 */
function markWindow(blocks: BlockLike[]): string {
  const middle = blocks.length % 2 === 1 ? Math.floor(blocks.length / 2) : blocks.length / 2 - 1;
  return blocks
    .map((block, index) => (index === middle ? `${CURSOR_START}\n${block.text}\n${CURSOR_END}` : block.text))
    .join('\n\n');
}

/**
 * Plan all windows for a draft: non-overlapping 3-block windows with the
 * tail absorbed into the last window, and each window's middle block marked
 * with cursor markers. Empty document -> empty plan.
 *
 * @param markdown the full draft markdown
 * @returns one plan entry per window, in document order
 */
export function planSweep(markdown: string): SweepWindowPlan[] {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) return [];

  const plan: SweepWindowPlan[] = [];
  for (let i = 0; i < blocks.length; i += WINDOW_BLOCKS) {
    const windowBlocks = blocks.slice(i, i + WINDOW_BLOCKS);
    plan.push({
      markedText: markWindow(windowBlocks),
      startOffset: windowBlocks[0].start,
    });
  }
  return plan;
}

/**
 * Run a sweep sequentially over an already-planned list. Windows are asked
 * ONE AFTER ANOTHER; onNote fires as soon as each window's ask resolves, so
 * annotations appear progressively in plan order.
 *
 * After each ask, the question is anchored with extractAnchor using the
 * window's start offset as the cursor hint. When the answer does not anchor
 * anywhere (extractAnchor returns null) or the anchor lands OUTSIDE the
 * window's own block bounds (a quote from elsewhere in the draft), the note
 * is logged and skipped — a sweep never emits an unanchored or
 * out-of-window annotation.
 *
 * Throws only when coach.ask throws: a failing ask aborts the whole sweep
 * mid-way by design, surfaced to the caller with the notes so far discarded.
 *
 * @param plan the windows to ask, in document order
 * @param opts genre, the coach seam, the full draft, and the onNote callback
 * @returns every note that anchored inside its window, in plan order
 */
export async function runSweep(
  plan: SweepWindowPlan[],
  opts: {
    genre: Genre;
    coach: { ask(textWindow: string, genre: Genre, cursorOffset: number): Promise<string> };
    draft: string;
    onNote(note: SweepNote): void;
  },
): Promise<SweepNote[]> {
  // Map each planned window's start offset to its block span in the draft,
  // using the same non-overlapping 3-block grouping planSweep uses.
  const boundsByStart = new Map<number, { start: number; end: number }>();
  const blocks = splitBlocks(opts.draft);
  for (let i = 0; i < blocks.length; i += WINDOW_BLOCKS) {
    const last = blocks[Math.min(i + WINDOW_BLOCKS - 1, blocks.length - 1)];
    boundsByStart.set(blocks[i].start, { start: blocks[i].start, end: last.end });
  }

  const notes: SweepNote[] = [];
  for (let index = 0; index < plan.length; index++) {
    const window = plan[index];
    const raw = await opts.coach.ask(window.markedText, opts.genre, window.startOffset);
    // The model sometimes quotes the literal marker tokens when grounding in
    // the marked region ("In the detail \"[CURSOR START] ...\""). Strip them —
    // they are our plumbing, never the writer's words.
    const question = raw.replace(/\[CURSOR (START|END)\]/g, '').replace(/\s{2,}/g, ' ').trim();

    const anchor = extractAnchor(question, opts.draft, window.startOffset);
    const bounds = boundsByStart.get(window.startOffset) ?? null;
    if (anchor === null || bounds === null || anchor.start < bounds.start || anchor.end > bounds.end) {
      console.warn(
        `[coach-sweep] skipping window ${index}: the coach's answer did not anchor inside the window bounds`,
      );
      continue;
    }

    const note: SweepNote = {
      start: anchor.start,
      end: anchor.end,
      fragment: anchor.fragment,
      question,
      windowIndex: index,
      ts: Date.now(),
    };
    notes.push(note);
    opts.onNote(note);
  }
  return notes;
}

/**
 * Strip annotations whose fragment no longer matches the draft at their
 * offsets (text moved or edited since the annotation was created).
 *
 * @param annotations persisted annotations to check
 * @param draft the current draft markdown
 * @returns the annotations whose fragment still matches, in input order
 */
export function staleAnnotations(annotations: AnchorRecordLike[], draft: string): AnchorRecordLike[] {
  return annotations.filter((annotation) => draft.slice(annotation.start, annotation.end) === annotation.fragment);
}
