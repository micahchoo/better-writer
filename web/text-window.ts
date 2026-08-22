/**
 * text-window: the pure module that assembles a "window" of markdown for the
 * coach — the marked text sent to /ask and the envelope of the cursor block
 * inside it.
 *
 * Block = paragraph, list item, or heading (a line starting with `#`).
 * A window is built from ALREADY-EXTRACTED block texts via buildAskWindow:
 * the blocks joined with blank lines, the marked block wrapped in
 * [CURSOR START]/[CURSOR END]. findCursorEnvelope locates that marked block
 * inside a built window and reports its span as offsets into the unmarked
 * text.
 *
 * splitBlocks is the parser: it slices markdown into blocks for callers that
 * need structure (anchor, coach-sweep). markFullDraft wraps a whole-draft
 * window around a cursor offset for the server.
 *
 * Cursor on an empty line (a gap between blocks): the next block is treated
 * as the cursor block, falling back to the last block at the end of the
 * document. Empty document -> empty window.
 */

type BlockKind = 'paragraph' | 'list-item' | 'heading';

interface Block {
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

/**
 * The marked text sent to /ask: a window's blocks joined with blank lines,
 * the marked block wrapped in [CURSOR START]/[CURSOR END]. Consumers read
 * `.text` as the wire payload; buildAskWindow is the only constructor.
 */
export interface AskWindow {
  readonly text: string;
}

/**
 * The span of the marked block inside an UNMARKED window, as character
 * offsets. `start`/`end` index the window text with every marker token
 * removed, so `unmarked.slice(start, end)` recovers exactly the marked block
 * (including the newlines the markers sat on).
 */
export interface CursorEnvelope {
  start: number;
  end: number;
}

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
 * Locate the marked block in a built window and report its span as offsets
 * into the UNMARKED window text (marker tokens removed, nothing else
 * collapsed). Returns null when either marker is missing or the END marker
 * precedes the START marker.
 *
 * The content between the markers is unchanged by marker removal, so its
 * unmarked span is [start, end - CURSOR_START.length): the START token is
 * gone and the END token sits just after the content.
 */
export function findCursorEnvelope(markedText: string): CursorEnvelope | null {
  const start = markedText.indexOf(CURSOR_START);
  const end = markedText.indexOf(CURSOR_END);
  if (start === -1 || end === -1 || end < start) return null;
  return { start, end: end - CURSOR_START.length };
}

/**
 * Return the full markdown with [CURSOR START]/[CURSOR END] wrapped around
 * the cursor block, so the server sees the whole draft plus the cursor
 * envelope. Cursor-block selection follows this module's rule: a cursor on an
 * empty line takes the next block, falling back to the last block at the end
 * of the document. Empty document -> empty string.
 */
export function markFullDraft(markdown: string, cursorOffset: number): string {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) return '';

  const index = findCursorBlock(blocks, cursorOffset);
  if (index === -1) return '';

  const block = blocks[index];
  return (
    markdown.slice(0, block.start) +
    `${CURSOR_START}\n` +
    markdown.slice(block.start, block.end) +
    `\n${CURSOR_END}` +
    markdown.slice(block.end)
  );
}

/**
 * Split markdown into blocks, tracking each block's offsets.
 *
 * Lines are grouped into blocks; a blank line ends a block. Within a run of
 * non-blank lines, a heading line is always its own block, a list-marker line
 * starts a new list-item block (a following non-marker line is a lazy
 * continuation of that item), and anything else continues a paragraph.
 */
export function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let current: { lines: string[]; start: number; kind: BlockKind } | null = null;

  const close = () => {
    if (!current) return;
    const text = current.lines.join('\n');
    blocks.push({ text, start: current.start, end: current.start + text.length, kind: current.kind });
    current = null;
  };

  let offset = 0;
  for (const rawLine of markdown.split('\n')) {
    const lineStart = offset;
    // Strip a trailing CR so CRLF documents keep clean block text.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    offset += rawLine.length + 1;

    if (line.trim() === '') {
      close();
      continue;
    }
    if (HEADING_RE.test(line)) {
      close();
      blocks.push({ text: line, start: lineStart, end: lineStart + line.length, kind: 'heading' });
      continue;
    }
    const isListItem = LIST_ITEM_RE.test(line);
    if (!current) {
      current = { lines: [line], start: lineStart, kind: isListItem ? 'list-item' : 'paragraph' };
    } else if (current.kind === 'list-item') {
      if (isListItem) {
        close();
        current = { lines: [line], start: lineStart, kind: 'list-item' };
      } else {
        current.lines.push(line); // lazy continuation of the list item
      }
    } else if (isListItem) {
      close();
      current = { lines: [line], start: lineStart, kind: 'list-item' };
    } else {
      current.lines.push(line);
    }
  }
  close();
  return blocks;
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
