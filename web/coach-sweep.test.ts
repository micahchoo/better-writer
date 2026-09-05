import { describe, expect, it, vi } from 'vitest'
import type { Coach, CoachInput, CoachResult } from '../src/core/types.js'
import { cursorPlan, planSweep, reconcileAnnotations, runSweep, staleAnnotations } from './coach-sweep.js'

/**
 * A synthetic 10-block draft whose block texts are all unique, so anchor
 * spans can be located with indexOf and quoted verbatim with no ambiguity.
 * 10 short blocks, no heading -> windows [0-2], [3-5], [6-9] (1-block tail
 * merged into the last window).
 */
const BLOCKS_10 = [
  'Alpha beta gamma.',
  'Delta epsilon zeta.',
  'Eta theta iota.',
  'Kappa lambda mu.',
  'Nu xi omicron.',
  'Pi rho sigma.',
  'Tau upsilon phi.',
  'Chi psi omega.',
  'Aleph bet gimel.',
  'Daleth he waw.',
]

function doc(blocks: string[]): string {
  return blocks.join('\n\n')
}

/** The block planSweep marks in the window starting at windowIndex * 3. */
function markedBlock(blocks: string[], windowIndex: number): string {
  const windowBlocks = blocks.slice(windowIndex * 3, windowIndex * 3 + 3)
  const middle = windowBlocks.length % 2 === 1 ? Math.floor(windowBlocks.length / 2) : windowBlocks.length / 2 - 1
  return windowBlocks[middle]
}

/** The marked block's text inside a window's marked payload. */
function markedBlockText(markedText: string): string {
  const start = markedText.indexOf('[CURSOR START]\n') + '[CURSOR START]\n'.length
  const end = markedText.indexOf('\n[CURSOR END]', start)
  return markedText.slice(start, end)
}

/** Drain every queued microtask so a worker-pool continuation has fully run.
 * `await Promise.resolve()` is not enough here: a resolved window's own
 * continuation only schedules the worker's next-ask continuation, so the
 * pool can take two microtask rounds to claim the following window. A zero-
 * delay macrotask runs after the whole microtask queue empties, making the
 * intermediate assertions deterministic. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('planSweep', () => {
  it('merges a 10-block tail into the last window for 3 total windows', () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    expect(plan).toHaveLength(3)
    expect(plan.map((w) => w.bounds.start)).toEqual([
      draft.indexOf(BLOCKS_10[0]),
      draft.indexOf(BLOCKS_10[3]),
      draft.indexOf(BLOCKS_10[6]),
    ])
  })

  it('wraps only the middle block of each window in cursor markers', () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    expect(plan[0].markedText).toBe(
      `${BLOCKS_10[0]}\n\n[CURSOR START]\n${BLOCKS_10[1]}\n[CURSOR END]\n\n${BLOCKS_10[2]}`,
    )
    expect(plan[1].markedText).toBe(
      `${BLOCKS_10[3]}\n\n[CURSOR START]\n${BLOCKS_10[4]}\n[CURSOR END]\n\n${BLOCKS_10[5]}`,
    )
    // The merged tail window [6-9] marks its middle block (block 7).
    expect(plan[2].markedText).toBe(
      `${BLOCKS_10[6]}\n\n[CURSOR START]\n${BLOCKS_10[7]}\n[CURSOR END]\n\n${BLOCKS_10[8]}\n\n${BLOCKS_10[9]}`,
    )
    // Exactly one START and one END marker per window.
    for (const window of plan) {
      expect(window.markedText.split('[CURSOR START]')).toHaveLength(2)
      expect(window.markedText.split('[CURSOR END]')).toHaveLength(2)
    }
  })

  it('wraps the earlier of the two middle blocks in an even-sized window', () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    // The merged [6-9] window is even-sized; it marks block 7 (the earlier
    // of the two middles), never block 8.
    expect(plan[2].markedText).toBe(
      `${BLOCKS_10[6]}\n\n[CURSOR START]\n${BLOCKS_10[7]}\n[CURSOR END]\n\n${BLOCKS_10[8]}\n\n${BLOCKS_10[9]}`,
    )
    expect(plan[2].markedText).not.toContain(`[CURSOR START]\n${BLOCKS_10[8]}`)
  })

  it('forces two plans across a heading that a 3-stride would bridge', () => {
    const intro = 'An opening paragraph.'
    const heading = '## The Turn'
    const body = ['The body after the heading.', 'More body.', 'Still more body.']
    const draft = doc([intro, heading, ...body])
    const plan = planSweep(draft)
    // A 3-stride would group [intro, heading, body[0]]; sections force the
    // intro into its own window and the heading's section into another.
    expect(plan).toHaveLength(2)
    expect(plan[0].markedText).toBe(`[CURSOR START]\n${intro}\n[CURSOR END]`)
    expect(plan[1].markedText).toBe(
      `${heading}\n\n[CURSOR START]\n${body[0]}\n[CURSOR END]\n\n${body[1]}\n\n${body[2]}`,
    )
  })

  it('emits an over-budget paragraph as a single-block window without splitting', () => {
    const big = 'x'.repeat(1300)
    const draft = doc([big, 'Short one.', 'Short two.'])
    const plan = planSweep(draft)
    expect(plan).toHaveLength(2)
    expect(plan[0].markedText).toBe(`[CURSOR START]\n${big}\n[CURSOR END]`)
    // The 2-block tail would merge into [big], but that exceeds the budget,
    // so the stub stays a separate window.
    expect(plan[1].markedText).toBe(`[CURSOR START]\nShort one.\n[CURSOR END]\n\nShort two.`)
  })

  it('places cursorHint inside each window\u2019s marked block', () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    for (const window of plan) {
      const marked = markedBlockText(window.markedText)
      const start = draft.indexOf(marked)
      expect(window.cursorHint).toBeGreaterThanOrEqual(start)
      expect(window.cursorHint).toBeLessThanOrEqual(start + marked.length)
    }
  })

  it('gives every window bounds that exactly cover its own blocks', () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    // Known grouping for 10 short blocks: [0-2], [3-5], [6-9].
    const spans = [
      [0, 2],
      [3, 5],
      [6, 9],
    ]
    spans.forEach(([first, last], i) => {
      const start = draft.indexOf(BLOCKS_10[first])
      const end = draft.indexOf(BLOCKS_10[last]) + BLOCKS_10[last].length
      expect(plan[i].bounds).toEqual({ start, end })
    })
  })

  it('keeps 3-block windows stable for a no-heading draft that splits evenly', () => {
    const blocks = Array.from({ length: 9 }, (_, i) => `Paragraph ${i}.`)
    const draft = doc(blocks)
    const plan = planSweep(draft)
    // 9 short blocks, no heading: exactly [0-2], [3-5], [6-8], no merge needed.
    expect(plan).toHaveLength(3)
    expect(plan.map((w) => w.bounds.start)).toEqual([
      draft.indexOf(blocks[0]),
      draft.indexOf(blocks[3]),
      draft.indexOf(blocks[6]),
    ])
    expect(plan[2].markedText).toBe(
      `${blocks[6]}\n\n[CURSOR START]\n${blocks[7]}\n[CURSOR END]\n\n${blocks[8]}`,
    )
  })

  it('refuses a tail merge that would inflate a full window past WINDOW_BLOCKS + 1 blocks', () => {
    // 5 short blocks, no heading: the greedy pass yields [0-2] and [3-4].
    // The Q4 tail merge must NOT fold the 2-block stub onto the already-full
    // 3-block window (that would be a 5-block window); the stub stands alone.
    const blocks = Array.from({ length: 5 }, (_, i) => `Merge block ${i}.`)
    const draft = doc(blocks)
    const plan = planSweep(draft)
    expect(plan).toHaveLength(2)
    // The 2-block stub is its own window starting at block 3.
    expect(plan[1].bounds.start).toBe(draft.indexOf(blocks[3]))
    expect(plan[1].bounds.end).toBe(draft.indexOf(blocks[4]) + blocks[4].length)
    // A 3-block window plus a 1-block stub still merges to a 4-block tail.
    const ten = doc(BLOCKS_10)
    const tenPlan = planSweep(ten)
    expect(tenPlan).toHaveLength(3) // [0-2], [3-5], [6-9]
    expect(tenPlan[2].bounds.end).toBe(ten.indexOf(BLOCKS_10[9]) + BLOCKS_10[9].length)
  })

  it('is deterministic for the same input', () => {
    const draft = doc(BLOCKS_10)
    expect(planSweep(draft)).toEqual(planSweep(draft))
  })

  it('returns an empty plan for an empty draft', () => {
    expect(planSweep('')).toEqual([])
    expect(planSweep('\n\n')).toEqual([])
  })
})

describe('staleAnnotations', () => {
  it('keeps annotations whose fragment still matches the draft', () => {
    const draft = doc(BLOCKS_10)
    const annotations = [
      {
        start: draft.indexOf(BLOCKS_10[0]),
        end: draft.indexOf(BLOCKS_10[0]) + BLOCKS_10[0].length,
        fragment: BLOCKS_10[0],
      },
    ]
    expect(staleAnnotations(annotations, draft)).toEqual(annotations)
  })

  it('remaps an annotation whose fragment moved intact after an upstream edit', () => {
    const original = doc(BLOCKS_10)
    const oldPos = original.indexOf(BLOCKS_10[3])
    const annotation = { start: oldPos, end: oldPos + BLOCKS_10[3].length, fragment: BLOCKS_10[3] }
    const edited = `Intro paragraph.\n\n${original}`
    const newPos = edited.indexOf(BLOCKS_10[3])
    expect(newPos).toBeGreaterThan(oldPos)
    expect(staleAnnotations([annotation], edited)).toEqual([{ ...annotation, start: newPos, end: newPos + BLOCKS_10[3].length }])
  })

  it('preserves question and ts through a remap', () => {
    const original = doc(BLOCKS_10)
    const oldPos = original.indexOf(BLOCKS_10[3])
    const annotation = { start: oldPos, end: oldPos + BLOCKS_10[3].length, fragment: BLOCKS_10[3], question: 'why?', ts: 7 }
    const edited = `${original}\n\nEpilogue.`
    const [remapped] = staleAnnotations([annotation], edited)
    expect(remapped).toMatchObject({ start: edited.indexOf(BLOCKS_10[3]), question: 'why?', ts: 7 })
  })

  it('drops annotations whose fragment was deleted from the draft', () => {
    const draft = 'Totally different prose.'
    const stale = { start: 0, end: 17, fragment: 'Alpha beta gamma.', question: 'q', ts: 1 }
    expect(staleAnnotations([stale], draft)).toEqual([])
  })

  it('keeps the valid and remaps or drops the rest in a mixed list', () => {
    const draft = doc(BLOCKS_10)
    const pos = draft.indexOf(BLOCKS_10[1])
    const valid = { start: pos, end: pos + BLOCKS_10[1].length, fragment: BLOCKS_10[1], question: 'q1', ts: 1 }
    const stale = { start: 0, end: 12, fragment: 'not in the draft anymore', question: 'q2', ts: 2 }
    expect(staleAnnotations([valid, stale], draft)).toEqual([valid])
  })

  it('prefers the nearest occurrence among duplicates', () => {
    // 'echo' appears at offsets 8 and 29; an anchor last seen beside the
    // second must remap to it, not to the first one.
    const draft = 'alpha.\n\necho\n\nbeta.\n\ngamma.\n\necho\n\ndelta.'
    const second = draft.lastIndexOf('echo')
    const annotation = { start: second, end: second + 4, fragment: 'echo' }
    const drifted = { ...annotation, start: annotation.start + 3, end: annotation.start + 7 }
    const [remapped] = staleAnnotations([drifted], draft)
    expect(remapped?.start).toBe(second)
  })
  it('drops an annotation when two occurrences are equidistant from its old position', () => {
    // 'ab' at offsets 0 and 14; old position sits exactly between them.
    const draft = 'ab\n\nxx xx xx\n\nab'
    const annotation = { start: 7, end: 9, fragment: 'ab' }
    expect(staleAnnotations([annotation], draft)).toEqual([])
  })

  it('drops annotations pointing past the end of the draft with no matching fragment', () => {
    const annotation = { start: 5, end: 999, fragment: 'nope' }
    expect(staleAnnotations([annotation], 'short.')).toEqual([])
  })

  it('drops an empty-fragment annotation instead of letting it survive forever', () => {
    const draft = doc(BLOCKS_10)
    const empty = { start: 0, end: 0, fragment: '', question: 'q', ts: 1 }
    // The exact-offset check would otherwise match '' === draft.slice(0, 0)
    // and keep this invisible note riding every save forever.
    expect(staleAnnotations([empty], draft)).toEqual([])
    // reconcileAnnotations reports the drop so a length/identity consumer
    // adopts the cleaned list instead of persisting the degenerate note.
    const { valid, changed } = reconcileAnnotations([empty], draft)
    expect(valid).toEqual([])
    expect(changed).toBe(true)
  })

  it('handles an empty annotation list', () => {
    expect(staleAnnotations([], 'any draft')).toEqual([])
  })
})

describe('reconcileAnnotations', () => {
  it('reports changed=false and identity-equal entries when nothing moved', () => {
    const draft = doc(BLOCKS_10)
    const pos = draft.indexOf(BLOCKS_10[0])
    const note = { start: pos, end: pos + BLOCKS_10[0].length, fragment: BLOCKS_10[0], question: 'q', ts: 1 }
    const { valid, changed } = reconcileAnnotations([note], draft)
    expect(changed).toBe(false)
    expect(valid[0]).toBe(note)
  })

  it('reports changed=true for a pure remap that keeps the count identical', () => {
    // The regression this guards: a length-only check sees no change here,
    // so the remapped offsets were never adopted and the stale span was saved.
    const original = doc(BLOCKS_10)
    const oldPos = original.indexOf(BLOCKS_10[3])
    const note = { start: oldPos, end: oldPos + BLOCKS_10[3].length, fragment: BLOCKS_10[3], question: 'q', ts: 2 }
    const edited = `Intro.\n\n${original}`
    const newPos = edited.indexOf(BLOCKS_10[3])
    const untouched = { start: edited.indexOf(BLOCKS_10[5]), end: edited.indexOf(BLOCKS_10[5]) + BLOCKS_10[5].length, fragment: BLOCKS_10[5] }
    const { valid, changed } = reconcileAnnotations([note, untouched], edited)
    expect(valid).toHaveLength(2) // count did NOT change
    expect(changed).toBe(true)
    expect(valid[0]).not.toBe(note)
    expect(valid[0]).toMatchObject({ start: newPos, end: newPos + BLOCKS_10[3].length })
    expect(valid[1]).toBe(untouched) // identity preserved for the unmoved note
  })

  it('reports changed=true when an annotation is dropped', () => {
    const draft = doc(BLOCKS_10)
    const gone = { start: 0, end: 4, fragment: 'gone', question: 'q', ts: 3 }
    const { changed } = reconcileAnnotations([gone], draft)
    expect(changed).toBe(true)
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function answer(input: CoachInput, source: 'seed' | 'reshaped' = 'reshaped'): CoachResult {
  const focus = input.focus!
  const quote = input.textWindow.slice(focus.start, focus.end)
  return { kind: 'question', question: `Why "${quote}"?`, source, evidence: { ...focus, quote } }
}

describe('runSweep result and lifetime contract', () => {
  const draft = doc(BLOCKS_10)
  const plan = planSweep(draft)
  it('preserves raw separators and actual section position in the request', async () => {
    const raw = '# Title\n\nFirst.\n\n\nSecond.\n\nThird.\n\nFourth.'
    const windows = planSweep(raw)
    const coach: Coach = { ask: vi.fn(async input => answer(input)) }
    await runSweep(windows, { coach, draft: raw, genre: 'fiction', onNote() {} })
    for (const window of windows) {
      expect(window.textWindow).toBe(raw.slice(window.bounds.start, window.bounds.end))
      expect(window.position.sectionBlockCount).toBe(5)
    }
    expect(windows[1].position.blockIndexInSection).toBe(3)
    expect(coach.ask).toHaveBeenCalledWith(expect.objectContaining({ textWindow: windows[1].textWindow, position: windows[1].position }), expect.any(AbortSignal))
  })
  it('drains in plan order and keeps provenance with reversed completion', async () => {
    const pending = plan.map(() => deferred<CoachResult>())
    const inputs: CoachInput[] = []
    const coach: Coach = { ask: input => { inputs.push(input); return pending[inputs.length - 1].promise } }
    const onNote = vi.fn()
    const running = runSweep(plan, { coach, draft, genre: 'fiction', onNote })
    pending[1].resolve(answer(inputs[1], 'seed'))
    await flush()
    expect(onNote).not.toHaveBeenCalled()
    expect(inputs).toHaveLength(3)
    pending[2].resolve(answer(inputs[2]))
    pending[0].resolve(answer(inputs[0]))
    const result = await running
    expect(result.notes.map(n => n.windowIndex)).toEqual([0, 1, 2])
    expect(result.notes.map(n => n.source)).toEqual(['reshaped', 'seed', 'reshaped'])
    expect(result.asked).toBe(3)
  })
  it('counts no-fit, invalid output, and unavailable as skipped', async () => {
    const results: CoachResult[] = [{ kind: 'skip', reason: 'no-fit' }, { kind: 'skip', reason: 'invalid-output' }, { kind: 'unavailable', retryable: true }]
    const coach: Coach = { ask: async () => results.shift()! }
    const onNote = vi.fn()
    expect(await runSweep(plan, { coach, draft, genre: 'fiction', onNote })).toMatchObject({ notes: [], asked: 0, skipped: 3, requested: 3, noFit: 1, invalid: 1, unavailable: 1, unanchored: 0 })
    expect(onNote).not.toHaveBeenCalled()
  })
  it('rejects missing and forged evidence for reshaped questions', async () => {
    const results: CoachResult[] = [
      { kind: 'question', source: 'reshaped', question: `Why "${BLOCKS_10[1]}"?` },
      { kind: 'question', source: 'reshaped', question: 'Why?', evidence: { quote: 'forged', start: 0, end: 6 } },
      { kind: 'question', source: 'reshaped', question: 'Why?', evidence: { quote: BLOCKS_10[9], start: -1, end: 10 } },
    ]
    const result = await runSweep(plan, { coach: { ask: async () => results.shift()! }, draft, genre: 'fiction', onNote() {} })
    expect(result.skipped).toBe(3)
  })
  it('rejects evidence outside focus and evidence absent from the question', async () => {
    const coach: Coach = { ask: async input => {
      const quote = input.textWindow.split('\n')[0]
      return { kind: 'question', source: 'reshaped', question: `Why "${quote}"?`, evidence: { quote, start: 0, end: quote.length } }
    } }
    const outside = await runSweep(plan, { coach, draft, genre: 'fiction', onNote() {} })
    expect(outside.unanchored).toBe(3)
    const unused: Coach = { ask: async input => ({ ...answer(input), question: 'Why this detail?' } as CoachResult) }
    const absent = await runSweep(plan, { coach: unused, draft, genre: 'fiction', onNote() {} })
    expect(absent.unanchored).toBe(3)
  })
  it('stops midflight and prevents all late callbacks even if the coach ignores abort', async () => {
    const pending = deferred<CoachResult>()
    const signals: AbortSignal[] = []
    const inputs: CoachInput[] = []
    const coach: Coach = { ask: (input, signal) => { inputs.push(input); signals.push(signal!); return pending.promise } }
    const controller = new AbortController()
    const onNote = vi.fn(); const onProgress = vi.fn()
    const running = runSweep(plan, { coach, draft, genre: 'fiction', onNote, onProgress, signal: controller.signal })
    controller.abort()
    expect(await running).toMatchObject({ notes: [], asked: 0, skipped: 3 })
    expect(signals.every(s => s.aborted)).toBe(true)
    pending.resolve(answer(inputs[0]))
    await flush()
    expect(onNote).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(inputs).toHaveLength(2)
  })
  it('aborts siblings on rejection with no callbacks after settlement', async () => {
    const pending = [deferred<CoachResult>(), deferred<CoachResult>()]
    const inputs: CoachInput[] = []; const signals: AbortSignal[] = []
    const coach: Coach = { ask: (input, signal) => { inputs.push(input); signals.push(signal!); return pending[inputs.length - 1].promise } }
    const onNote = vi.fn(); const onProgress = vi.fn()
    const running = runSweep(plan, { coach, draft, genre: 'fiction', onNote, onProgress })
    pending[0].reject(new Error('server down'))
    await expect(running).rejects.toThrow('server down')
    expect(signals.every(s => s.aborted)).toBe(true)
    pending[1].resolve(answer(inputs[1]))
    await flush()
    expect(onNote).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(inputs).toHaveLength(2)
  })
  it('does not drain a later result past a failed earlier window', async () => {
    const pending = plan.map(() => deferred<CoachResult>())
    const inputs: CoachInput[] = []
    const coach: Coach = { ask: input => { inputs.push(input); return pending[inputs.length - 1].promise } }
    const onNote = vi.fn()
    const running = runSweep(plan, { coach, draft, genre: 'fiction', onNote })
    pending[1].resolve(answer(inputs[1])); await flush()
    pending[0].reject(new Error('failed'))
    await expect(running).rejects.toThrow('failed')
    pending[2].resolve(answer(inputs[2])); await flush()
    expect(onNote).not.toHaveBeenCalled()
  })
  it('allows static quoted seeds only inside their own window', async () => {
    const quote = BLOCKS_10[9]
    const coach: Coach = { ask: async () => ({ kind: 'question', source: 'seed', question: `Why "${quote}"?` }) }
    const result = await runSweep(plan, { coach, draft, genre: 'fiction', onNote() {} })
    expect(result.notes.map(n => n.windowIndex)).toEqual([2])
    expect(result.asked + result.skipped).toBe(plan.length)
  })
  it('anchors repeated evidence to its own raw window offsets', async () => {
    const repeated = 'The same sentence.'
    const raw = doc(['One.', repeated, 'Two.', 'Three.', repeated, 'Four.'])
    const windows = planSweep(raw)
    const coach: Coach = { ask: async input => ({ kind: 'question', source: 'reshaped', question: `Why "${repeated}"?`, evidence: { quote: repeated, ...input.focus! } }) }
    const result = await runSweep(windows, { coach, draft: raw, genre: 'fiction', onNote() {} })
    expect(result.notes.map(n => n.start)).toEqual([raw.indexOf(repeated), raw.lastIndexOf(repeated)])
  })
  it('returns exhaustive counters for an empty plan', async () => {
    const ask = vi.fn()
    expect(await runSweep([], { coach: { ask }, draft: '', genre: 'fiction', onNote() {} })).toMatchObject({ notes: [], asked: 0, skipped: 0 })
    expect(ask).not.toHaveBeenCalled()
  })
})


describe('cursorPlan', () => {
  it('keeps raw CRLF and reports section position outside the selected window', () => {
    const raw = '# First\r\n\r\nBefore.\r\n\r\n# Second\r\n\r\nA.\r\n\r\nB.\r\n\r\nC.\r\n\r\nD.'
    const window = cursorPlan(raw, raw.indexOf('C.'))!
    expect(window.textWindow).toBe('B.\r\n\r\nC.\r\n\r\nD.')
    expect(window.position).toEqual({ sectionBlockCount: 5, blockIndexInSection: 3 })
    expect(window.textWindow.slice(window.focus.start, window.focus.end)).toBe('C.\r')
  })
  it('clips neighbors to section bounds and does not ask about a rule', () => {
    const raw = 'Before.\n\n---\n\nAfter.\n\nLast.'
    expect(cursorPlan(raw, raw.indexOf('After.'))!.textWindow).toBe('After.\n\nLast.')
    expect(cursorPlan(raw, raw.indexOf('---'))).toBeNull()
    expect(cursorPlan('', 0)).toBeNull()
  })
})
