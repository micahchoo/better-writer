// Selection arms for the deterministic-window-metrics targeting experiment.
//
// Baseline arm: uniform random draw over the (already genre-filtered) pool —
// identical to the seed bank's current behavior. Treated arm: two-stage draw
// that prefers seeds whose question (+ source.quote) lexically matches any
// flagged axis, falling back to a uniform draw when the matched pool is thin
// or empty. Decoupled from sibling ruler code: flags arrive as plain string
// sets; the runner performs genre filtering outside.

import { readFileSync } from 'node:fs'
import { AXIS_POOLS, TOPIC_POOLS } from './lexicons'

export interface Seed {
  id: string
  question: string
  verb: string
  genre: string[]
  // source book/author/chapter/quote plus any future fields ride along
  [key: string]: unknown
}

/** Parse a seeds/bank.jsonl file into Seed records. */
export function loadSeeds(path: string): Seed[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Seed)
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g

/** Build a case-insensitive regex over the given literal keyword list. */
export function keywordsToRegex(keywords: string[]): RegExp {
  return new RegExp(
    keywords
      .map((k) => {
        const escaped = k.replace(ESCAPE, '\\$&')
        // single word -> word boundaries; phrase -> escaped literal (spaces match)
        return k.includes(' ') ? escaped : `\\b${escaped}\\b`
      })
      .join('|'),
    'i',
  )
}

const poolRegexCache = new Map<string, RegExp>()

/** Regex for a single craft-topic pool's keywords (cached). */
export function topicRegex(topic: string): RegExp {
  const cached = poolRegexCache.get(topic)
  if (cached) return cached
  const keywords = TOPIC_POOLS[topic]
  if (!keywords) throw new Error(`unknown topic: ${topic}`)
  const re = keywordsToRegex(keywords)
  poolRegexCache.set(topic, re)
  return re
}

const axisRegexCache = new Map<string, RegExp>()

/** Regex for a flattened axis lexicon (all pools the axis draws from). */
export function axisRegex(axis: string): RegExp {
  const cached = axisRegexCache.get(axis)
  if (cached) return cached
  const pools = AXIS_POOLS[axis as keyof typeof AXIS_POOLS]
  if (!pools) throw new Error(`unknown axis: ${axis}`)
  const re = keywordsToRegex(pools.flatMap((pool) => TOPIC_POOLS[pool]))
  axisRegexCache.set(axis, re)
  return re
}

function seedText(seed: Seed): string {
  const source = seed.source as { quote?: string } | undefined
  return seed.question + (source?.quote ? ` ${source.quote}` : '')
}

/**
 * True iff the seed's question (or source.quote) contains any keyword of ANY
 * flagged axis's lexicon.
 */
export function matchAxis(seed: Seed, axisFlags: Set<string>): boolean {
  for (const axis of axisFlags) {
    if (axisRegex(axis).test(seedText(seed))) return true
  }
  return false
}

/**
 * True iff the seed's question (or source.quote) contains any keyword of the
 * given craft-topic pool. `topic` names a TOPIC_POOLS key (the fixture
 * ground-truth vocabulary, e.g. 'scene-setting', 'show-tell-dramatize').
 */
export function topicMatch(seed: Seed, topic: string): boolean {
  return topicRegex(topic).test(seedText(seed))
}

/** Uniform random sample over the pool (mirrors current bank behavior). */
export function pullBaseline(pool: Seed[], rng: () => number): Seed {
  return pool[Math.floor(rng() * pool.length)]
}

/**
 * Treated draw: prefer a seed matching any flagged axis. Two-stage: flip
 * rng()<p (p = min(0.5, matched/16), so thin pools are trusted less); when the
 * flip lands, draw uniformly from the matched pool; otherwise (or when the
 * matched pool is empty) fall back to a uniform baseline draw.
 */
export function pullTreated(
  pool: Seed[],
  flags: Set<string>,
  rng: () => number,
): Seed {
  const matched = pool.filter((seed) => matchAxis(seed, flags))
  const p = Math.min(0.5, matched.length / 16)
  if (matched.length > 0 && rng() < p) {
    return matched[Math.floor(rng() * matched.length)]
  }
  return pullBaseline(pool, rng)
}

/** Deterministic PRNG (mulberry32). Same seed -> same sequence. */
export function makeRng(seedNum: number): () => number {
  let a = seedNum >>> 0
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
