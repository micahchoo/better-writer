import { describe, expect, it, vi } from 'vitest'
import type { Genre, QuestionSource } from '../src/types.js'
import { planSweep, reconcileAnnotations, runSweep, staleAnnotations } from './coach-sweep.js'

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

  it('is deterministic for the same input', () => {
    const draft = doc(BLOCKS_10)
    expect(planSweep(draft)).toEqual(planSweep(draft))
  })

  it('returns an empty plan for an empty draft', () => {
    expect(planSweep('')).toEqual([])
    expect(planSweep('\n\n')).toEqual([])
  })
})

describe('runSweep', () => {
  it('asks windows through a bounded pool and reports notes in plan order', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    const callOrder: string[] = []
    const pending: Array<{ resolve: (question: string) => void }> = []
    const coach = {
      ask(textWindow: string, _genre: Genre, _cursorOffset: number): Promise<string> {
        const index = callOrder.length
        callOrder.push(textWindow)
        // Promise.withResolvers needs the es2024 lib; this project targets
        // es2022, so the executor form is the only way to hold a resolver.
        return new Promise<string>((resolve) => {
          pending[index] = { resolve }
        })
      },
    }
    const onNote = vi.fn()
    const sweepPromise = runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    // The pool of 2 starts two asks at once.
    await Promise.resolve()
    expect(callOrder).toHaveLength(2)

    // Resolve answers in order; each resolution unlocks the next ask.
    for (let i = 0; i < plan.length; i++) {
      pending[i].resolve(`Rewrite "${markedBlock(BLOCKS_10, i)}" with more force`)
      await Promise.resolve()
    }

    const { notes } = await sweepPromise
    expect(callOrder).toHaveLength(plan.length)
    expect(callOrder).toEqual(plan.map((w) => w.markedText))
    expect(notes).toHaveLength(plan.length)
    expect(onNote).toHaveBeenCalledTimes(plan.length)
    for (let i = 0; i < plan.length; i++) {
      expect(onNote.mock.calls[i][0]).toEqual(notes[i])
      expect(notes[i].windowIndex).toBe(i)
      expect(notes[i].fragment).toBe(markedBlock(BLOCKS_10, i))
      expect(draft.slice(notes[i].start, notes[i].end)).toBe(notes[i].fragment)
    }
  })

  it('never runs more than two asks in flight at once', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    let inFlight = 0
    let maxInFlight = 0
    const pending: Array<{ resolve: (question: string) => void }> = []
    const coach = {
      ask(textWindow: string, _genre: Genre, _cursorOffset: number): Promise<string> {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        const index = pending.length
        return new Promise<string>((resolve) => {
          pending[index] = {
            resolve: (question: string) => {
              inFlight--
              resolve(question)
            },
          }
        })
      },
    }
    const onNote = vi.fn()
    const sweepPromise = runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    // The pool fills to its cap of 2 immediately.
    await Promise.resolve()
    expect(pending).toHaveLength(2)
    expect(maxInFlight).toBe(2)

    // A new ask may start only after one resolves; the cap never grows.
    pending[0].resolve(`Rewrite "${markedBlock(BLOCKS_10, 0)}" with more force`)
    await flush()
    expect(pending).toHaveLength(3)
    expect(maxInFlight).toBe(2)

    // Window 1 resolves; window 2 is already claimed, so no new ask starts.
    pending[1].resolve(`Rewrite "${markedBlock(BLOCKS_10, 1)}" with more force`)
    await flush()
    expect(pending).toHaveLength(3)
    expect(maxInFlight).toBe(2)

    pending[2].resolve(`Rewrite "${markedBlock(BLOCKS_10, 2)}" with more force`)
    const { notes } = await sweepPromise
    expect(maxInFlight).toBe(2)
    expect(notes).toHaveLength(plan.length)
  })

  it('emits notes in ascending window index even when answers resolve out of order', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    const pending: Array<(question: string) => void> = []
    const coach = {
      ask(_textWindow: string, _genre: Genre, _cursorOffset: number): Promise<string> {
        return new Promise<string>((resolve) => {
          pending.push(resolve)
        })
      },
    }
    const onNote = vi.fn()
    const sweepPromise = runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    await Promise.resolve()
    expect(pending).toHaveLength(2) // windows 0 and 1 in flight

    const q = (i: number) => `Rewrite "${markedBlock(BLOCKS_10, i)}" with more force`
    // Resolve in the order 1, 2, 0 — window 1 finishing frees a worker to
    // start window 2, so the ordered emitter must hold both until window 0
    // arrives.
    pending[1](q(1))
    await flush()
    pending[2](q(2))
    await flush()
    expect(onNote).not.toHaveBeenCalled() // window 0 still pending blocks the prefix

    pending[0](q(0))
    await flush()

    const { notes } = await sweepPromise
    expect(onNote).toHaveBeenCalledTimes(3)
    expect(onNote.mock.calls.map((c) => c[0].windowIndex)).toEqual([0, 1, 2])
    expect(notes.map((n) => n.windowIndex)).toEqual([0, 1, 2])
  })

  it('skips a window whose answer quotes text from elsewhere in the draft', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    const responses = [
      `Rewrite "${BLOCKS_10[3]}" elsewhere`, // block 3 lives in window 1, not window 0
      `Rewrite "${markedBlock(BLOCKS_10, 1)}" with more force`,
      `Rewrite "${markedBlock(BLOCKS_10, 2)}" with more force`,
    ]
    const coach = { ask: async () => responses.shift() ?? 'What does the reader feel here?' }
    const onNote = vi.fn()
    const { notes } = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toHaveLength(2)
    expect(onNote).toHaveBeenCalledTimes(2)
    expect(notes.map((n) => n.windowIndex)).toEqual([1, 2])
    expect(notes[0].fragment).toBe(BLOCKS_10[4])
  })

  it('anchors a note in a merged-tail window whose last block sits inside the plan bounds', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft) // [0-2], [3-5], [6-9]: the merged 4-block tail
    // Every ask quotes the LAST block of the merged tail (block 9). That
    // block lives inside window 2's own plan bounds, so only window 2
    // anchors; a stride-3 re-derivation would put block 9 outside and skip.
    const coach = { ask: async () => `Rewrite "${BLOCKS_10[9]}" with more force` }
    const onNote = vi.fn()
    const { notes } = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toHaveLength(1)
    expect(notes[0].windowIndex).toBe(2)
    expect(notes[0].fragment).toBe(BLOCKS_10[9])
    expect(onNote).toHaveBeenCalledTimes(1)
  })

  it('anchors every note in a heading-split plan using each window\u2019s own bounds', async () => {
    const intro = 'An opening paragraph.'
    const heading = '## The Turn'
    const body = ['The body after the heading.', 'More body.', 'Still more body.']
    const draft = doc([intro, heading, ...body])
    const plan = planSweep(draft) // [intro], [heading, body0, body1, body2]
    expect(plan).toHaveLength(2)
    const responses = [
      `Rewrite "${intro}" with more force`, // window 0: single-block window
      `Rewrite "${body[2]}" with more force`, // window 1: last block of the 4-block section window
    ]
    const coach = { ask: async () => responses.shift() ?? 'What does the reader feel here?' }
    const onNote = vi.fn()
    const { notes } = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toHaveLength(2)
    expect(notes.map((n) => n.windowIndex)).toEqual([0, 1])
    expect(notes[0].fragment).toBe(intro)
    expect(notes[1].fragment).toBe(body[2])
  })

  it('tie-breaks twin paragraphs at a window\u2019s two ends toward the marked block', async () => {
    const twin = 'The lighthouse keeper never blinked.'
    const filler = 'A gust rattled the shutters.'
    const marked = 'Marked middle paragraph here.'
    const tail = 'Morning arrived wet and grey.'
    const draft = doc([twin, filler, marked, twin, tail]) // one 5-block window, marked = block 2
    const plan = planSweep(draft)
    expect(plan).toHaveLength(1)
    // The quote occurs at block 0 and block 3; the plan's cursorHint sits in
    // the marked block (block 2), which is closer to the LATER twin — so the
    // anchor must land there, not on the first occurrence.
    const coach = { ask: async () => `Rewrite "${twin}" with more force` }
    const onNote = vi.fn()
    const { notes } = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toHaveLength(1)
    expect(notes[0].fragment).toBe(twin)
    expect(notes[0].start).toBe(draft.lastIndexOf(twin))
  })

  it('skips every window when the coach answers with topic-probe questions', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    const coach = {
      async ask(): Promise<string> {
        return 'What does the reader feel about pacing and structure in this passage?'
      },
    }
    const onNote = vi.fn()
    const { notes } = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toEqual([])
    expect(onNote).not.toHaveBeenCalled()
  })

  it('returns no notes for an empty plan without calling the coach', async () => {
    const onNote = vi.fn()
    const coach = { ask: vi.fn(async () => 'anything') }
    const { notes, asked, skipped } = await runSweep([], { genre: 'fiction', coach, draft: '', onNote })

    expect(notes).toEqual([])
    expect(asked).toBe(0)
    expect(skipped).toBe(0)
    expect(coach.ask).not.toHaveBeenCalled()
    expect(onNote).not.toHaveBeenCalled()
  })

  it('fires onProgress after every window, skipped anchors included', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    const responses = [
      `Rewrite "${BLOCKS_10[3]}" elsewhere`, // window 0: anchored outside its bounds -> skipped
      `Rewrite "${markedBlock(BLOCKS_10, 1)}" with more force`,
      `Rewrite "${markedBlock(BLOCKS_10, 2)}" with more force`,
    ]
    const coach = { ask: async () => responses.shift() ?? 'What does the reader feel here?' }
    const onNote = vi.fn()
    const onProgress = vi.fn()
    const { notes } = await runSweep(plan, { genre: 'fiction', coach, draft, onNote, onProgress })

    expect(notes).toHaveLength(2)
    expect(onNote).toHaveBeenCalledTimes(2)
    // Progress advances one window at a time, the skipped window included.
    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it('stops starting windows after shouldAbort flips, counting the aborted tail as skipped', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    const callOrder: string[] = []
    const pending: Array<{ resolve: (question: string) => void }> = []
    const coach = {
      ask(textWindow: string, _genre: Genre, _cursorOffset: number): Promise<string> {
        const index = callOrder.length
        callOrder.push(textWindow)
        return new Promise<string>((resolve) => {
          pending[index] = { resolve }
        })
      },
    }
    let shouldAbort = false
    const onNote = vi.fn()
    const onProgress = vi.fn()
    const sweepPromise = runSweep(plan, {
      genre: 'fiction',
      coach,
      draft,
      onNote,
      onProgress,
      shouldAbort: () => shouldAbort,
    })

    await Promise.resolve()
    expect(callOrder).toHaveLength(2) // pool: windows 0 and 1 are in flight
    pending[0].resolve(`Rewrite "${markedBlock(BLOCKS_10, 0)}" with more force`)
    pending[1].resolve(`Rewrite "${markedBlock(BLOCKS_10, 1)}" with more force`)
    // The writer hits Stop before either worker picks up a third window.
    shouldAbort = true

    // Resolves normally (no throw), with the notes that were in flight.
    const { notes, asked, skipped } = await sweepPromise
    expect(callOrder).toHaveLength(2) // window 2 was never asked
    expect(notes).toHaveLength(2)
    expect(notes.map((n) => n.windowIndex)).toEqual([0, 1])
    expect(notes[0].fragment).toBe(markedBlock(BLOCKS_10, 0))
    expect(notes[1].fragment).toBe(markedBlock(BLOCKS_10, 1))
    expect(onNote).toHaveBeenCalledTimes(2)
    // Aborted windows count as skipped; asked + skipped always covers the plan.
    expect(asked).toBe(2)
    expect(skipped).toBe(1)
    expect(asked + skipped).toBe(plan.length)
    // Progress advances only through the windows that resolved.
    expect(onProgress.mock.calls).toEqual([
      [1, plan.length],
      [2, plan.length],
    ])
  })

  it('sums asked and skipped to exactly the plan length across anchored, unanchored, and aborted windows', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft) // 3 windows
    const pending: Array<{ resolve: (question: string) => void }> = []
    const coach = {
      ask(_textWindow: string, _genre: Genre, _cursorOffset: number): Promise<string> {
        return new Promise<string>((resolve) => {
          pending.push({ resolve })
        })
      },
    }
    let shouldAbort = false
    const onNote = vi.fn()
    const sweepPromise = runSweep(plan, {
      genre: 'fiction',
      coach,
      draft,
      onNote,
      shouldAbort: () => shouldAbort,
    })

    await Promise.resolve()
    expect(pending).toHaveLength(2) // windows 0, 1 in flight
    // Window 0 anchors; window 1's answer quotes a block from another window
    // (block 0), so it fails to anchor inside window 1 -> skipped.
    pending[0].resolve(`Rewrite "${markedBlock(BLOCKS_10, 0)}" with more force`)
    pending[1].resolve(`Rewrite "${BLOCKS_10[0]}" elsewhere`)
    // Abort before any new window starts; window 2 is never asked.
    shouldAbort = true

    const { notes, asked, skipped } = await sweepPromise
    expect(notes).toHaveLength(1)
    expect(notes[0].windowIndex).toBe(0)
    expect(asked).toBe(1)
    expect(skipped).toBe(2) // window 1 unanchored + window 2 aborted
    expect(asked + skipped).toBe(plan.length)
    expect(onNote).toHaveBeenCalledTimes(1)
  })

  it('labels each note with the coach provenance read right after the ask', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft).slice(0, 1)
    let last: QuestionSource | null = null
    const coach = {
      ask: async (): Promise<string> => `Rewrite "${markedBlock(BLOCKS_10, 0)}" with more force`,
      lastSource: (): QuestionSource | null => last,
    }
    const onNote = vi.fn()

    // null before any ask: the note carries no source.
    const first = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })
    expect(first.notes[0].source).toBeUndefined()

    last = 'reshaped'
    const reshaped = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })
    expect(reshaped.notes[0].source).toBe('reshaped')

    last = 'topic-probe'
    const probed = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })
    expect(probed.notes[0].source).toBe('topic-probe')
  })

  it('leaves note.source absent when the coach exposes no provenance (static)', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft).slice(0, 1)
    const coach = { ask: async (): Promise<string> => `Rewrite "${markedBlock(BLOCKS_10, 0)}" with more force` }
    const onNote = vi.fn()
    const { notes } = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toHaveLength(1)
    expect(notes[0].source).toBeUndefined()
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
