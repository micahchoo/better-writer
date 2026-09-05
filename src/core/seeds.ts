/** Shared seed selection policy for local, browser, and evaluation adapters. */
import type { ClientSeed, Genre, CoachInput } from './types.js';
import { implVerbs, measureWindow } from './window-stats.js';
const GENRE_AGNOSTIC: Genre = 'genre-agnostic';

/**
 * A seed matches a genre filter when it carries that genre OR carries the
 * genre-agnostic wildcard, which matches any filter.
 */
export function seedMatchesGenre(seed: ClientSeed, genre: Genre): boolean {
  return seed.genre.includes(GENRE_AGNOSTIC) || seed.genre.includes(genre);
}

/**
 * Lazily-loaded seed bank. seeds/client.json (~563KB) would inline into the
 * main chunk under a static import; instead it ships as its own
 * dynamic-import chunk, fetched only when a coach first draws a seed. The
 * loaded module is cached, so a draw triggers at most ONE async load, and a
 * second coach (ByokCoach) reuses the same cached module through this shared
 * loader. Tests may inject explicit seeds to bypass the bank entirely.
 */
let seedsPromise: Promise<ClientSeed[]> | null = null
export function loadSeeds(): Promise<ClientSeed[]> {
  seedsPromise ??= import('../../seeds/client.json').then(
    (m) => ((m.default ?? m) as unknown) as ClientSeed[],
  )
  return seedsPromise
}

/**
 * The random surface the seed drawer needs: uniform [0,1) draws plus a
 * uniform pick from a sequence — the same surface seeds/retrieve.py's `pull`
 * expects of its `rng` argument, so a seeded MT19937 can reproduce server
 * draws exactly (see coach-pickseed tests). Production uses the
 * Math.random-backed default.
 */
export interface RngLike {
  random(): number;
  choice<T>(seq: T[]): T;
}

/** The default rng: plain Math.random — the pre-parity uniform drawer. */
const MATH_RNG: RngLike = {
  random: () => Math.random(),
  choice: (seq) => seq[Math.floor(Math.random() * seq.length)],
};

/**
 * Soft preference for pickSeed: matching seeds have the specified per-seed
 * weight. Mirrors seeds/retrieve.py's pull().
 */
export interface SeedPreference {
  verbs?: string[];
  /** Per-seed weight for a matched seed; defaults to PREFERENCE_WEIGHT. */
  weight?: number;
}

/**
 * How much likelier a PREFERRED seed is than a non-preferred one, PER SEED
 * (PREFERENCE_WEIGHT in seeds/retrieve.py — keep the two in step).
 */
const PREFERENCE_WEIGHT = 3;

/**
 * Stage-one probability of drawing from the matched pile, derived from the
 * two pile sizes so that the per-seed ratio is exactly `weight`.
 *
 * The old rule set the probability of the PILE (min(0.5, matched/16)), so the
 * per-seed rate was 0.5/matched and moved with pile size instead of intent:
 * fiction's 898 genre-specific seeds ended up 0.64x as likely PER SEED as the
 * 563 agnostic ones — backwards — while poetry's 8 specific seeds took ~51%
 * of all draws (H2-3).
 */
function stageOneProbability(matched: number, complement: number, weight: number): number {
  const weighted = weight * matched;
  return weighted / (weighted + complement);
}

/**
 * With an explicit `preference` (verbs set) it reproduces retrieve.py's
 * pull(): a two-stage draw that with probability
 * `stageOneProbability(matched, complement, weight)` picks uniformly from the
 * matched pile, else uniformly from its complement — so a matched seed is
 * exactly `weight` times likelier per seed than an unmatched one, whatever
 * the piles measure. The verbs-preference OVERRIDES the default
 * genre stratification (folded OUT to avoid double-narrowing), mirroring the
 * CLI where --lean-verbs wins over --genre's default.
 *
 * With no explicit preference, an internal default genre preference engages
 * when the genre filter produced a genuinely mixed pool — at least one card
 * strictly carries `genre` AND at least one matches only via the
 * genre-agnostic wildcard. Then each specific-genre card is PREFERENCE_WEIGHT
 * times likelier than each agnostic one, matching retrieve.py's
 * default_genre_preference. A single-group pool (all specific, or all
 * agnostic-only) or a bare full-bank pull keeps the legacy uniform draw.
 * `rng` is injectable for reproducible draws; it defaults to Math.random.
 */
export function pickSeed(
  seeds: ClientSeed[],
  genre: Genre,
  preference?: SeedPreference,
  rng: RngLike = MATH_RNG,
): ClientSeed {
  const pool = seeds.filter((seed) => seedMatchesGenre(seed, genre));
  if (pool.length === 0) {
    throw new Error(`No seeds available for genre "${genre}".`);
  }
  if (preference && preference.verbs && preference.verbs.length > 0) {
    const verbs = new Set(preference.verbs);
    const matched = pool.filter((seed) => verbs.has(seed.verb ?? ''));
    if (matched.length === 0) {
      return rng.choice(pool);
    }
    const matchedIds = new Set(matched.map((s) => s.id));
    const complement = pool.filter((s) => !matchedIds.has(s.id));
    const weight = preference.weight ?? PREFERENCE_WEIGHT;
    if (rng.random() < stageOneProbability(matched.length, complement.length, weight)) {
      return rng.choice(matched);
    }
    if (complement.length === 0) {
      return rng.choice(pool);
    }
    return rng.choice(complement);
  }
  // No explicit preference: default genre stratification over a mixed pool.
  const specific = pool.filter((seed) => seed.genre.includes(genre));
  const agnosticOnly = pool.filter(
    (seed) => !seed.genre.includes(genre) && seed.genre.includes(GENRE_AGNOSTIC),
  );
  if (specific.length === 0 || agnosticOnly.length === 0) {
    return rng.choice(pool);
  }
  const specificIds = new Set(specific.map((s) => s.id));
  const complement = pool.filter((s) => !specificIds.has(s.id));
  if (rng.random() < stageOneProbability(specific.length, complement.length, PREFERENCE_WEIGHT)) {
    return rng.choice(specific);
  }
  if (complement.length === 0) {
    return rng.choice(pool);
  }
  return rng.choice(complement);
}

/** Draw distinct questions, spreading candidates across intervention kinds. */
export function drawCandidates(seeds: ClientSeed[], input: CoachInput, count = 3, rng: RngLike = MATH_RNG): ClientSeed[] {
  let pool = seeds.filter(seed => seedMatchesGenre(seed, input.genre));
  const preferred = implVerbs(measureWindow(input.textWindow, input.position));
  const selected: ClientSeed[] = [];
  while (pool.length && selected.length < count) {
    const unusedVerbs = pool.filter(seed => !selected.some(picked => picked.verb === seed.verb));
    const candidates = selected.length && unusedVerbs.length ? unusedVerbs : pool;
    const picked = pickSeed(candidates, input.genre, preferred.length ? { verbs: preferred } : undefined, rng);
    selected.push(picked);
    pool = pool.filter(seed => seed.id !== picked.id && seed.question !== picked.question);
  }
  return selected;
}
