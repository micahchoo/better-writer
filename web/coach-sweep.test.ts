import { describe, expect, it, vi } from 'vitest'
import type { Genre } from '../src/types.js'
import { planSweep, runSweep, staleAnnotations } from './coach-sweep.js'

/**
 * A synthetic 10-block draft whose block texts are all unique, so anchor
 * spans can be located with indexOf and quoted verbatim with no ambiguity.
 * 10 blocks -> windows [0-2], [3-5], [6-8], [9] (tail absorbed).
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

describe('planSweep', () => {
  it('splits a 10-block draft into 4 non-overlapping windows with the tail absorbed', () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    expect(plan).toHaveLength(4)
    expect(plan.map((w) => w.startOffset)).toEqual([
      draft.indexOf(BLOCKS_10[0]),
      draft.indexOf(BLOCKS_10[3]),
      draft.indexOf(BLOCKS_10[6]),
      draft.indexOf(BLOCKS_10[9]),
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
    // A one-block tail window wraps its only block.
    expect(plan[3].markedText).toBe(`[CURSOR START]\n${BLOCKS_10[9]}\n[CURSOR END]`)
    // Exactly one START and one END marker per window.
    for (const window of plan) {
      expect(window.markedText.split('[CURSOR START]')).toHaveLength(2)
      expect(window.markedText.split('[CURSOR END]')).toHaveLength(2)
    }
  })

  it('wraps the earlier of the two middle blocks in an even-sized tail window', () => {
    const draft = doc(BLOCKS_10.slice(0, 8))
    const plan = planSweep(draft)
    expect(plan).toHaveLength(3)
    expect(plan[2].markedText).toBe(`[CURSOR START]\n${BLOCKS_10[6]}\n[CURSOR END]\n\n${BLOCKS_10[7]}`)
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
  it('asks windows one after another and reports notes in plan order', async () => {
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

    // While the first window's answer is pending, no further ask may start.
    await Promise.resolve()
    expect(callOrder).toHaveLength(1)

    // Resolve answers one at a time; each resolution must unlock the next ask.
    for (let i = 0; i < plan.length; i++) {
      expect(callOrder).toHaveLength(i + 1)
      pending[i].resolve(`Rewrite "${markedBlock(BLOCKS_10, i)}" with more force`)
      await Promise.resolve()
    }

    const notes = await sweepPromise
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

  it('skips a window whose answer quotes text from elsewhere in the draft', async () => {
    const draft = doc(BLOCKS_10)
    const plan = planSweep(draft)
    const responses = [
      `Rewrite "${BLOCKS_10[3]}" elsewhere`, // block 3 lives in window 1, not window 0
      `Rewrite "${markedBlock(BLOCKS_10, 1)}" with more force`,
      `Rewrite "${markedBlock(BLOCKS_10, 2)}" with more force`,
      `Rewrite "${markedBlock(BLOCKS_10, 3)}" with more force`,
    ]
    const coach = { ask: async () => responses.shift() ?? 'What does the reader feel here?' }
    const onNote = vi.fn()
    const notes = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toHaveLength(3)
    expect(onNote).toHaveBeenCalledTimes(3)
    expect(notes.map((n) => n.windowIndex)).toEqual([1, 2, 3])
    expect(notes[0].fragment).toBe(BLOCKS_10[4])
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
    const notes = await runSweep(plan, { genre: 'fiction', coach, draft, onNote })

    expect(notes).toEqual([])
    expect(onNote).not.toHaveBeenCalled()
  })

  it('returns no notes for an empty plan without calling the coach', async () => {
    const onNote = vi.fn()
    const coach = { ask: vi.fn(async () => 'anything') }
    const notes = await runSweep([], { genre: 'fiction', coach, draft: '', onNote })

    expect(notes).toEqual([])
    expect(coach.ask).not.toHaveBeenCalled()
    expect(onNote).not.toHaveBeenCalled()
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

  it('drops annotations whose fragment no longer matches the draft', () => {
    const draft = doc(BLOCKS_10)
    const stale = { start: 0, end: 10, fragment: 'Alpha beta gamma.', question: 'q', ts: 1 }
    expect(staleAnnotations([stale], draft)).toEqual([])
  })

  it('keeps the valid and drops the stale in a mixed list', () => {
    const draft = doc(BLOCKS_10)
    const pos = draft.indexOf(BLOCKS_10[1])
    const valid = { start: pos, end: pos + BLOCKS_10[1].length, fragment: BLOCKS_10[1], question: 'q1', ts: 1 }
    const stale = { start: 0, end: 12, fragment: 'Alpha beta gamma.', question: 'q2', ts: 2 }
    expect(staleAnnotations([valid, stale], draft)).toEqual([valid])
  })

  it('drops annotations pointing past the end of the draft', () => {
    const annotation = { start: 5, end: 999, fragment: 'nope' }
    expect(staleAnnotations([annotation], 'short.')).toEqual([])
  })

  it('handles an empty annotation list', () => {
    expect(staleAnnotations([], 'any draft')).toEqual([])
  })
})
