/**
 * h2-pickseed-groups.ts — quantify per-seed preference DIRECTION per genre.
 * pickSeed splits a mixed pool into specific-pile (seeds tagged with the
 * genre) and agnostic-only-pile, then does a PILE-level 50/50 draw. Per-seed,
 * a smaller pile is over-represented and a larger pile under-represented.
 * This measures the resulting per-seed rate per group to show when the
 * "prefer specific" preference inverts or dominates.
 */
import { readFileSync } from 'node:fs';
import { pickSeed, seedMatchesGenre } from '../../web/coach.js';
import type { ClientSeed, Genre } from '../../src/core/types.js';

const seeds = JSON.parse(readFileSync('seeds/client.json', 'utf8')) as ClientSeed[];
const GENRES: Genre[] = ['fiction', 'creative-nonfiction', 'memoir', 'essay', 'poetry', 'genre-agnostic'];
const DRAWS = 20000;

let s = 987654321;
const rng = {
  random: () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  },
  choice: <T,>(seq: T[]): T => seq[Math.floor(rng.random() * seq.length)],
};

for (const genre of GENRES) {
  const pool = seeds.filter((x) => seedMatchesGenre(x, genre));
  const specific = pool.filter((x) => x.genre.includes(genre));
  const agnOnly = pool.filter((x) => !x.genre.includes(genre) && x.genre.includes('genre-agnostic'));
  if (specific.length === 0 || agnOnly.length === 0) {
    console.log(`${genre}: single-group pool (specific=${specific.length} agnOnly=${agnOnly.length}) — uniform draw, no preference`);
    continue;
  }
  const effP = Math.min(0.5, specific.length / 16);
  let specDraws = 0;
  const specIds = new Set(specific.map((x) => x.id));
  for (let i = 0; i < DRAWS; i++) {
    const p = pickSeed(seeds, genre, undefined, rng);
    if (specIds.has(p.id)) specDraws++;
  }
  const agnDraws = DRAWS - specDraws;
  const specPerSeed = specDraws / specific.length;      // expected draws per specific seed
  const agnPerSeed = agnDraws / Math.max(1, agnOnly.length); // per agnostic-only seed
  const ratio = specPerSeed / agnPerSeed;
  console.log(
    `${genre}: specific=${specific.length} agnOnly=${agnOnly.length} effP=${effP.toFixed(3)} ` +
    `| specific pile got ${((specDraws / DRAWS) * 100).toFixed(1)}% | per-seed specific=${specPerSeed.toFixed(2)} agnOnly=${agnPerSeed.toFixed(2)} ` +
    `| specific:agnostic per-seed ratio=${ratio.toFixed(2)} (${ratio > 1 ? 'prefers specific' : ratio < 1 ? 'PREFERS AGNOSTIC (inverted)' : 'neutral'})`,
  );
}
