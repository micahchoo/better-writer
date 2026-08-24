import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AXES, AXIS_POOLS, LEXICONS, TOPIC_POOLS } from './lexicons'
import {
  loadSeeds,
  makeRng,
  matchAxis,
  pullBaseline,
  pullTreated,
  topicMatch,
} from './arms'
import type { Seed } from './arms'

// repo-root-relative path resolution: scripts/experiment/../../seeds/bank.jsonl
const BANK_PATH = fileURLToPath(new URL('../../seeds/bank.jsonl', import.meta.url))

const DIALOGUE = new Set(['dialogue'])

describe('loadSeeds', () => {
  it('parses the full bank', () => {
    const seeds = loadSeeds(BANK_PATH)
    expect(seeds.length).toBe(1709)
    // every record carries the runtime contract fields
    for (const s of seeds) {
      expect(typeof s.id).toBe('string')
      expect(typeof s.question).toBe('string')
      expect(typeof s.verb).toBe('string')
      expect(Array.isArray(s.genre)).toBe(true)
    }
  })
})

describe('makeRng determinism', () => {
  it('same seed -> identical pull sequence x20', () => {
    const pool = loadSeeds(BANK_PATH)
    const seq = (rng: () => number, n = 20) =>
      Array.from({ length: n }, () => pullTreated(pool, DIALOGUE, rng).id)
    expect(seq(makeRng(42))).toEqual(seq(makeRng(42)))
    expect(seq(makeRng(7))).toEqual(seq(makeRng(7)))
    // different seeds diverge
    expect(seq(makeRng(42))).not.toEqual(seq(makeRng(7)))
  })
})

describe('topicMatch & lexicons', () => {
  it('topicMatch resolves every fixture topic vocabulary', () => {
    const seeds = loadSeeds(BANK_PATH)
    // every pool key used by axes must be resolvable
    for (const axis of AXES) {
      for (const pool of AXIS_POOLS[axis]) {
        expect(TOPIC_POOLS[pool], `missing pool ${pool}`).toBeTruthy()
      }
    }
    const someHit = seeds.some((s) => topicMatch(s, 'scene-setting'))
    expect(someHit).toBe(true)
  })

  it('scene-setting is a real lexical class over the bank', () => {
    const seeds = loadSeeds(BANK_PATH)
    const n = seeds.filter((s) => topicMatch(s, 'scene-setting')).length
    expect(n).toBeGreaterThan(0)
  })
})

describe('treated vs baseline statistical sanity', () => {
  it('treated arm prefers dialogue-matching seeds', () => {
    const pool = loadSeeds(BANK_PATH)
    const N = 400
    const hitRate = (draw: () => Seed) => {
      let hits = 0
      for (let i = 0; i < N; i++) {
        if (matchAxis(draw(), DIALOGUE)) hits++
      }
      return hits / N
    }
    const rngB = makeRng(99)
    const rngT = makeRng(99)
    const baselineRate = hitRate(() => pullBaseline(pool, rngB))
    const treatedRate = hitRate(() => pullTreated(pool, DIALOGUE, rngT))
    // report both numbers
    console.log(`baseline P(dialogue-hit) = ${(baselineRate * 100).toFixed(2)}%`)
    console.log(`treated  P(dialogue-hit) = ${(treatedRate * 100).toFixed(2)}%`)
    expect(treatedRate).toBeGreaterThan(baselineRate)
  })
})

// Runtime matched-pool-size table (printed for the experiment report).
describe('matched-pool sizes (report)', () => {
  it('prints per-axis matched pool sizes across the full bank', () => {
    const seeds = loadSeeds(BANK_PATH)
    const table = AXES.map((axis) => {
      const n = seeds.filter((s) => matchAxis(s, new Set([axis]))).length
      return `${axis}: ${n} (${((n / seeds.length) * 100).toFixed(1)}%)`
    }).join('\n')
    console.log(`matched-pool sizes (n=${seeds.length}):\n${table}`)
    // all non-empty -> every treated arm has a non-empty matched pool
    for (const axis of AXES) {
      expect(seeds.some((s) => matchAxis(s, new Set([axis])))).toBe(true)
    }
  })

  it('lexicon maps are complete for every axis', () => {
    for (const axis of AXES) {
      expect(LEXICONS[axis].length).toBeGreaterThan(0)
    }
  })
})
