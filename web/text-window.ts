/**
 * text-window: the pure module that assembles a "window" of markdown for the
 * coach — a slice of the draft around a focus, never the whole document.
 *
 * Block = paragraph, list item, or heading (a line starting with `#`).
 * A window is built from ALREADY-EXTRACTED block texts via buildAskWindow:
 * the blocks joined with blank lines, the marked block wrapped in
 * [CURSOR START]/[CURSOR END].
 *
 * splitBlocks is the parser: it slices markdown into blocks for callers that
 * need structure (anchor, coach-sweep). partitionSections regroups blocks at
 * headings and thematic breaks. cursorWindow selects the live auto-ask
 * window: the block under the cursor plus one neighbor on each side, so a
 * cursor-centered window matches a sweep window's shape by construction.
 * Sweep-plan windows are cut in coach-sweep at section boundaries within a
 * character budget; this module never assembles a whole-draft window.
 *
 * Cursor on an empty line (a gap between blocks): the next block is treated
 * as the cursor block, falling back to the last block at the end of the
 * document. Empty document -> empty window.
 */

type BlockKind = 'paragraph' | 'list-item' | 'heading';

export interface Block {
  text: string;
  /** offset of the block's first character in the markdown */
  start: number;
  /** offset just past the block's last character */
  end: number;
  kind: BlockKind;
}

export const CURSOR_START = '[CURSOR START]';
export const CURSOR_END = '[CURSOR END]';

/** A list marker: `- x`, `* x`, `+ x`, `1. x`, `1) x` (leading indent allowed). */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
/** An ATX heading: `#`…`######` followed by a space or end of line. */
const HEADING_RE = /^#{1,6}(?:\s|$)/;
/** A thematic break line: three or more `-`, `*`, or `_` (a section boundary). */
const THEMATIC_BREAK_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
/** A setext heading underline: a run of `=` (h1) or 1-2 `-`/`*` (h2) under a
 * paragraph. Runs of 3+ `-`/`*`/`_` are thematic breaks (above) and never
 * reach this — so only `=+` and `-{1,2}`/`*{1,2}` are seen here. */
const SETEXT_UNDERLINE_RE = /^\s*(?:=+|-{1,2}|\*{1,2})\s*$/;

/**
 * Join block texts into a window with blank lines, wrapping the block at
 * `markIndex` in [CURSOR START]/[CURSOR END]. A null `markIndex` leaves the
 * window unmarked. Contains no markdown-parsing logic — callers slice the
 * document into blocks first (see splitBlocks), so this stays a pure
 * assembly of already-extracted texts.
 */
export function buildAskWindow(blocksTexts: string[], markIndex: number | null): string {
  return blocksTexts
    .map((text, index) => (index === markIndex ? `${CURSOR_START}\n${text}\n${CURSOR_END}` : text))
    .join('\n\n');
}

/**
 * Split markdown into blocks, tracking each block's offsets.
 *
 * Lines are grouped into blocks; a blank line ends a block. Within a run of
 * non-blank lines, a heading line is always its own block, a setext underline
 * turns the accumulated paragraph into a heading, a thematic break is always
 * its own block (glued or standalone), a list-marker line starts a new
 * list-item block (a following non-marker line is a lazy continuation of that
 * item), and anything else continues a paragraph.
 *
 * Offsets index the raw markdown. Block text is CR-stripped, so for a CRLF
 * source a block's `end` may sit past `text.length`; `markdown.slice(start,
 * end)` with CRs removed equals `text`.
 */
export function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let current: { lines: string[]; start: number; rawEnd: number; kind: BlockKind } | null = null;

  const close = () => {
    if (!current) return;
    const text = current.lines.join('\n');
    blocks.push({ text, start: current.start, end: current.rawEnd, kind: current.kind });
    current = null;
  };

  let offset = 0;
  for (const rawLine of markdown.split('\n')) {
    const lineStart = offset;
    const lineEnd = lineStart + rawLine.length; // end of the line in the raw doc (excludes the newline)
    // Strip a trailing CR so CRLF documents keep clean block text.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    offset += rawLine.length + 1;

    if (line.trim() === '') {
      close();
      continue;
    }
    if (HEADING_RE.test(line)) {
      close();
      blocks.push({ text: line, start: lineStart, end: lineEnd, kind: 'heading' });
      continue;
    }
    if (THEMATIC_BREAK_RE.test(line)) {
      // A thematic break is always its own block — even glued to the
      // preceding paragraph it terminates that block (S2-2).
      close();
      blocks.push({ text: line, start: lineStart, end: lineEnd, kind: 'paragraph' });
      continue;
    }
    if (
      SETEXT_UNDERLINE_RE.test(line) &&
      current &&
      current.kind === 'paragraph' &&
      current.lines.length > 0
    ) {
      // An underline directly under paragraph content: the paragraph is a
      // setext heading (S2-2). 3+ `-`/`*`/`_` runs were caught above as
      // thematic breaks, so only `=+` and 1-2 `-`/`*` land here.
      const text = current.lines.join('\n') + '\n' + line;
      blocks.push({ text, start: current.start, end: lineEnd, kind: 'heading' });
      current = null;
      continue;
    }
    const isListItem = LIST_ITEM_RE.test(line);
    if (!current) {
      current = { lines: [line], start: lineStart, rawEnd: lineEnd, kind: isListItem ? 'list-item' : 'paragraph' };
    } else if (current.kind === 'list-item') {
      if (isListItem) {
        close();
        current = { lines: [line], start: lineStart, rawEnd: lineEnd, kind: 'list-item' };
      } else {
        current.lines.push(line); // lazy continuation of the list item
        current.rawEnd = lineEnd;
      }
    } else if (isListItem) {
      close();
      current = { lines: [line], start: lineStart, rawEnd: lineEnd, kind: 'list-item' };
    } else {
      current.lines.push(line);
      current.rawEnd = lineEnd;
    }
  }
  close();
  return blocks;
}

/**
 * Partition blocks into sections at boundary blocks: a heading or a thematic
 * break line starts a new section, and every block after a boundary belongs
 * to that section until the next boundary. Blocks before the first boundary
 * form their own section, so an intro paragraph that precedes the first
 * heading is not orphaned.
 *
 * This is the seam the sweep planner relies on (a window never spans two
 * sections); it preserves order, adjacency, and offsets — it only regroups.
 */
export function partitionSections(blocks: Block[]): Block[][] {
  const sections: Block[][] = [];
  for (const block of blocks) {
    const opens = block.kind === 'heading' || THEMATIC_BREAK_RE.test(block.text.trim());
    if (opens || sections.length === 0) {
      sections.push([block]);
    } else {
      sections[sections.length - 1].push(block);
    }
  }
  return sections;
}

/**
 * Select the cursor-centered window: the block holding `caretOffset` (end
 * inclusive), else the next block when the caret sits in a gap, else the
 * last block past the document's end — the same rule findCursorBlock
 * encodes. Returns the ±1-neighbor slice (edge-clipped) with the cursor
 * block's index within that slice as `markIndex`, or null for an empty
 * block list.
 *
 * This is the shared constructor askCursorWindow calls, so an auto-ask
 * window matches a sweep window's shape by construction, never re-derived
 * per caller.
 */
export function cursorWindow(
  blocks: Block[],
  caretOffset: number,
): { texts: string[]; markIndex: number } | null {
  if (blocks.length === 0) return null;
  const center = findCursorBlock(blocks, caretOffset);
  const from = Math.max(0, center - 1);
  const to = Math.min(blocks.length, center + 2);
  const windowBlocks = blocks.slice(from, to);
  return {
    texts: windowBlocks.map((block) => block.text),
    markIndex: center - from,
  };
}

/**
 * The block the cursor belongs to. A cursor at a block's end (inclusive)
 * belongs to that block; a cursor in a gap (blank lines between blocks)
 * belongs to the next block; a cursor past the last block belongs to the
 * last block.
 */
function findCursorBlock(blocks: Block[], offset: number): number {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (offset >= b.start && offset <= b.end) return i;
  }
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].start >= offset) return i;
  }
  return blocks.length - 1;
}
