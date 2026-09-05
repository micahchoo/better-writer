/** Shared re-exports for h9-* probes (THEMATIC_BREAK_RE is private in
 * text-window.ts, so probes re-derive it to classify degenerate windows). */
export { splitBlocks, partitionSections } from '../../src/core/text-window.js';
export const THEMATIC = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
