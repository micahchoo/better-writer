/**
 * text-window: the pure module that slices a markdown document around the
 * writer's cursor into a short "window" for the coach.
 *
 * Block = paragraph, list item, or heading (a line starting with `#`).
 * Window = the cursor block wrapped in [CURSOR START]/[CURSOR END] markers,
 * plus the block before it and 1-2 blocks after it, joined with blank lines.
 *
 * Section boundaries: the window STOPS at any heading. A heading is never
 * included in the window except when the cursor sits on the heading itself,
 * and no block on the far side of a heading is ever included.
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

const CURSOR_START = '[CURSOR START]';
const CURSOR_END = '[CURSOR END]';

/** A list marker: `- x`, `* x`, `+ x`, `1. x`, `1) x` (leading indent allowed). */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
/** An ATX heading: `#`…`######` followed by a space or end of line. */
const HEADING_RE = /^#{1,6}(?:\s|$)/;

export function textWindow(markdown: string, cursorOffset: number): string {
  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) return '';

  const index = findCursorBlock(blocks, cursorOffset);
  if (index === -1) return '';

  // The block before the cursor block — never across a heading.
  const before: string[] = [];
  for (let i = index - 1; i >= 0 && before.length < 1; i--) {
    if (blocks[i].kind === 'heading') break;
    before.unshift(blocks[i].text);
  }

  // 1-2 blocks after the cursor block — never across a heading.
  const after: string[] = [];
  for (let i = index + 1; i < blocks.length && after.length < 2; i++) {
    if (blocks[i].kind === 'heading') break;
    after.push(blocks[i].text);
  }

  const cursorBlock = `${CURSOR_START}\n${blocks[index].text}\n${CURSOR_END}`;
  return [...before, cursorBlock, ...after].join('\n\n');
}

/**
 * Split markdown into blocks, tracking each block's offsets.
 *
 * Lines are grouped into blocks; a blank line ends a block. Within a run of
 * non-blank lines, a heading line is always its own block, a list-marker line
 * starts a new list-item block (a following non-marker line is a lazy
 * continuation of that item), and anything else continues a paragraph.
 */
function splitBlocks(markdown: string): Block[] {
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
