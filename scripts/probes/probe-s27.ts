/**
 * probe-s27: S2-7 baseline/after measure. Mirrors probe12.ts's methodology
 * (draw N fiction seeds against SAMPLE_DRAFT at the mid-caret) but reads the
 * seed bank directly instead of coach.ts's bundledSeeds, so it runs even
 * while coach.ts is mid-refactor. Exact draws are not meant to be reproduced
 * — this is an approximate before/after gauge of single-generic-word junk.
 */
import { readFileSync } from 'node:fs';
import { SAMPLE_DRAFT } from '../../web/sample-draft.js';
import { extractAnchor } from '../../web/anchor.js';

type Seed = { id: string; question: string; genre?: string[] };
const bank = readFileSync(new URL('../../seeds/bank.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Seed)
  .filter((s) => s.question && s.genre && s.genre.includes('fiction'));

const caret = Math.floor(SAMPLE_DRAFT.length / 2);
const N = 4000;
const lens: number[] = [];
const frags = new Map<string, number>();
let seeded = 0;
for (let i = 0; i < N; i++) {
  const a = extractAnchor(bank[i % bank.length].question, SAMPLE_DRAFT, caret);
  if (!a) continue;
  seeded++;
  lens.push(a.fragment.length);
  frags.set(a.fragment, (frags.get(a.fragment) ?? 0) + 1);
}
const oneWord = [...frags.entries()].filter(([f]) => !/\s/.test(f));
const oneWordCount = oneWord.reduce((s, [, c]) => s + c, 0);
console.log('seeds sampled from bank:', bank.length);
console.log('anchored draws:', seeded, 'of', N);
console.log('single-WORD anchors:', oneWordCount, `= ${(100 * oneWordCount / seeded).toFixed(1)}% of anchored`);
console.log('fragments <= 5 chars:', lens.filter((l) => l <= 5).length, `= ${(100 * lens.filter((l) => l <= 5).length / seeded).toFixed(1)}%`);
console.log('median fragment chars:', lens.slice().sort((a, b) => a - b)[Math.floor(lens.length / 2)]);
console.log('\ntop 14 anchors the demo pins:');
[...frags.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 14)
  .forEach(([f, c]) => console.log(`  ${String(c).padStart(4)}x  ${JSON.stringify(f)}`));
