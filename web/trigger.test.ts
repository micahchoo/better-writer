import { describe, expect, it } from 'vitest'
import { ASK_IDLE_MS, ASK_WORD_THRESHOLD, AskTrigger } from './trigger'

interface Harness {
  trigger: AskTrigger
  now: () => number
  advance: (ms: number) => void
}

function makeTrigger(): Harness {
  let clock = 0
  return {
    trigger: new AskTrigger({ now: () => clock }),
    now: () => clock,
    advance: (ms) => {
      clock += ms
    },
  }
}

describe('AskTrigger.onWordsAdded', () => {
  it('fires when 30 words accumulate', () => {
    const { trigger } = makeTrigger()
    expect(trigger.onWordsAdded(29)).toBe(false)
    expect(trigger.onWordsAdded(1)).toBe(true)
  })

  it('fires at exactly the threshold', () => {
    const { trigger } = makeTrigger()
    expect(trigger.onWordsAdded(ASK_WORD_THRESHOLD)).toBe(true)
  })

  it('resets the counter after firing', () => {
    const { trigger } = makeTrigger()
    expect(trigger.onWordsAdded(30)).toBe(true)
    expect(trigger.onWordsAdded(29)).toBe(false) // counter was reset
    expect(trigger.onWordsAdded(1)).toBe(true)
  })

  it('never fires at zero or negative deltas', () => {
    const { trigger } = makeTrigger()
    expect(trigger.onWordsAdded(0)).toBe(false)
    expect(trigger.onWordsAdded(-5)).toBe(false)
    expect(trigger.onWordsAdded(10)).toBe(false) // accumulates but stays below the threshold
    expect(trigger.pendingWords).toBe(10)
  })

  it('accumulates net words — deletions subtract', () => {
    const { trigger } = makeTrigger()
    trigger.onWordsAdded(20)
    expect(trigger.onWordsAdded(-10)).toBe(false)
    expect(trigger.onWordsAdded(20)).toBe(true) // 20 - 10 + 20 = 30
  })

  it('rejects non-finite deltas', () => {
    const { trigger } = makeTrigger()
    expect(trigger.onWordsAdded(Number.NaN)).toBe(false)
    expect(trigger.onWordsAdded(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('AskTrigger.shouldFire (idle gate)', () => {
  it('a fresh trigger is armed (never fired)', () => {
    const { trigger, now } = makeTrigger()
    expect(trigger.shouldFire(now())).toBe(true)
  })

  it('blocks for 2s after a fire, then opens', () => {
    const { trigger } = makeTrigger()
    trigger.onWordsAdded(30) // fires at t=0
    expect(trigger.shouldFire(ASK_IDLE_MS - 1)).toBe(false)
    expect(trigger.shouldFire(ASK_IDLE_MS)).toBe(true)
  })

  it('manualAsk resets the word counter and re-arms the gate', () => {
    const { trigger, advance } = makeTrigger()
    trigger.onWordsAdded(20)
    trigger.manualAsk()
    expect(trigger.onWordsAdded(20)).toBe(false) // counter was reset
    expect(trigger.shouldFire(ASK_IDLE_MS - 1)).toBe(false)
    advance(ASK_IDLE_MS)
    expect(trigger.shouldFire(ASK_IDLE_MS)).toBe(true)
  })

  it('manual ask is never blocked by the gate (no throw, gate merely recorded)', () => {
    const { trigger } = makeTrigger()
    trigger.manualAsk()
    expect(trigger.pendingWords).toBe(0)
  })
})
