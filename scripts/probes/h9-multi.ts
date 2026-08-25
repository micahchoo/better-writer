/**
 * h9-multi: angle (a) — staleAnnotations' nearest-occurrence remap.
 *
 * Question: when the SAME fragment occurs multiple times, which occurrence
 * wins, and can an edit near the earlier occurrence make the WRONG one win?
 *
 * Hypothesis: the remap picks the occurrence nearest the annotation's OLD
 * start. When the annotated occurrence is the LATER of two identical
 * fragments and an edit inserts a large block BETWEEN them, the earlier
 * duplicate becomes the nearest to the stale offset — so the note jumps to
 * the wrong occurrence even though its true occurrence still exists intact.
 */
import { staleAnnotations } from '../../web/coach-sweep.js';

function show(label: string, frag: string, start: number): void {
  console.log(`  ${label}: offset ${start}`);
}

// Two occurrences of "echo" at p1 < p2; the annotation is pinned to the SECOND.
const oldDraft = 'Alpha beta gamma.\n\necho\n\nBeta gamma delta.\n\necho\n\nGamma delta epsilon.';
const p1 = oldDraft.indexOf('echo');
const p2 = oldDraft.lastIndexOf('echo');
const annotation = { start: p2, end: p2 + 4, fragment: 'echo' };

console.log('--- baseline (no edit): annotation on the SECOND occurrence ---');
console.log(`first occurrence at ${p1}, second at ${p2}`);
console.log(`annotation originally: start=${annotation.start}`);

// Edit: insert a large block BETWEEN the two occurrences (right after the
// first "echo" ends). The second occurrence shifts right by the insert size;
// the first stays put. If the insert is longer than the original gap, the
// FIRST occurrence is now nearer the stale start.
for (const gap of [2, 10, 40]) {
  const insert = 'X'.repeat(gap);
  const edited = oldDraft.slice(0, p1 + 4) + '\n\n' + insert + oldDraft.slice(p1 + 4);
  const [remapped] = staleAnnotations([annotation], edited);
  const secondNow = edited.lastIndexOf('echo');
  const firstNow = edited.indexOf('echo');
  console.log(`\n--- edit inserts ${gap} chars between the occurrences ---`);
  console.log(`occurrences now: first=${firstNow}, second=${secondNow}`);
  if (!remapped) {
    console.log('  DROPPED (no remap)');
    continue;
  }
  const which = remapped.start === secondNow ? 'SECOND (correct)' : remapped.start === firstNow ? 'FIRST (WRONG)' : '???';
  console.log(`  remapped start=${remapped.start} -> ${which}`);
  console.log(`  fragment=${JSON.stringify(edited.slice(remapped.start, remapped.end))}`);
}

// Control: same total insert but placed BEFORE both occurrences (a uniform
// upstream shift must preserve relative order -> still the second, correct).
console.log('\n--- control: insert of 40 chars BEFORE both occurrences ---');
{
  const edited = 'X'.repeat(40) + oldDraft;
  const [remapped] = staleAnnotations([annotation], edited);
  const secondNow = edited.lastIndexOf('echo');
  console.log(`  remapped start=${remapped.start}, second now=${secondNow}, correct=${remapped.start === secondNow}`);
}
