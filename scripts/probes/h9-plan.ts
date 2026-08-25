/**
 * h9-plan: angle (c) — planSweep window ordering and coverage.
 *
 * Question: does any window get visited twice or skipped when sections are
 * empty or thematic-break-heavy? Does a break-heavy doc produce degenerate
 * windows (a lone thematic-break block asked as a window)?
 */
import { planSweep } from '../../web/coach-sweep.js';
import { splitBlocks, partitionSections, THEMATIC } from './h9-shared.js';

function audit(label: string, md: string): void {
  const blocks = splitBlocks(md);
  const plan = planSweep(md);
  // Coverage: every block start must appear in exactly one window's bounds.
  const coverage = new Map<number, number>(); // blockStart -> count of windows containing it
  for (const w of plan) {
    for (const b of blocks) {
      if (b.start >= w.bounds.start && b.end <= w.bounds.end) {
        coverage.set(b.start, (coverage.get(b.start) ?? 0) + 1);
      }
    }
  }
  const double = [...coverage.values()].filter((n) => n > 1);
  const uncovered = blocks.filter((b) => !coverage.has(b.start));
  const degenerate = plan.filter((w) => {
    // a window whose markedText is ONLY a thematic-break block
    const t = w.markedText.replace(/\[CURSOR START\]|\[CURSOR END\]/g, '').replace(/\n+/g, '\n').trim();
    return /^-{3,}|\*{3,}|_{3,}$/.test(t);
  });
  console.log(`\n=== ${label} ===`);
  console.log(`blocks=${blocks.length}, windows=${plan.length}`);
  console.log(`blocks in 2+ windows (double-visit): ${double.length}`);
  console.log(`blocks in 0 windows (skipped): ${uncovered.length}`);
  if (uncovered.length) console.log(`  skipped: ${uncovered.map((b) => JSON.stringify(b.text)).join(', ')}`);
  if (degenerate.length) {
    console.log(`DEGENERATE windows whose only content is a thematic break: ${degenerate.length}`);
    for (const d of degenerate) console.log(`  bounds=[${d.bounds.start},${d.bounds.end}] markedText=${JSON.stringify(d.markedText)}`);
  }
  // window order + non-overlap check
  let prevEnd = -1;
  let overlap = false;
  for (const w of plan) {
    if (w.bounds.start < prevEnd) overlap = true;
    prevEnd = w.bounds.end;
  }
  console.log(`windows overlap each other: ${overlap}`);
  // gap check: any document byte not covered by any window (empty paragraphs
  // and separators are expected gaps; flag only if a NON-separator gap exists)
  const gaps: string[] = [];
  const sorted = [...plan].sort((a, b) => a.bounds.start - b.bounds.start);
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = md.slice(sorted[i].bounds.end, sorted[i + 1].bounds.start);
    if (gap.trim() !== '') gaps.push(JSON.stringify(gap));
  }
  console.log(`non-whitespace gaps between windows: ${gaps.length} ${gaps.length ? gaps.join(';') : ''}`);
}

audit('thematic-break-heavy', 'Para one.\n\n---\n\nPara two.\n\n---\n\nPara three.\n\n---\n\nPara four.');
audit('lone trailing break', 'Para one.\n\n---');
audit('break at very start', '---\n\nPara one.\n\nPara two.\n\nPara three.');
audit('10 unique blocks (baseline)', 'A.\n\nB.\n\nC.\n\nD.\n\nE.\n\nF.\n\nG.\n\nH.\n\nI.\n\nJ.');
audit('heading-split sections', '# One\n\nA.\n\nB.\n\nC.\n\n# Two\n\nD.\n\nE.');
