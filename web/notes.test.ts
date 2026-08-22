import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeNote, noteId, sameNote } from './notes'

const ANCHOR = { start: 4, end: 18, fragment: 'A hard sentence.' }
const QUESTION = 'How could this sentence be clearer?'

describe('note identity', () => {
  it('mints the full note shape from an anchor + question', () => {
    const note = makeNote(ANCHOR, QUESTION, 1_720_000_000_000)
    expect(note).toEqual({
      start: 4,
      end: 18,
      fragment: 'A hard sentence.',
      question: QUESTION,
      ts: 1_720_000_000_000,
    })
  })

  it('defaults ts to the current time when not pinned', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_720_000_000_000))
    try {
      expect(makeNote(ANCHOR, QUESTION).ts).toBe(1_720_000_000_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is stable: identical inputs mint identical ids', () => {
    const a = makeNote(ANCHOR, QUESTION, 1_720_000_000_000)
    const b = makeNote(ANCHOR, QUESTION, 1_720_000_000_000)
    expect(noteId(a)).toBe(noteId(b))
  })

  it('distinguishes notes minted at different times', () => {
    const earlier = noteId(makeNote(ANCHOR, QUESTION, 1_720_000_000_000))
    const later = noteId(makeNote(ANCHOR, QUESTION, 1_720_000_001_000))
    expect(later).not.toBe(earlier)
  })

  it('distinguishes notes anchored to different spans', () => {
    const a = noteId(makeNote(ANCHOR, QUESTION, 1_720_000_000_000))
    const b = noteId(makeNote({ ...ANCHOR, start: 0 }, QUESTION, 1_720_000_000_000))
    expect(b).not.toBe(a)
  })

  it('distinguishes notes with different end offsets', () => {
    const a = noteId(makeNote(ANCHOR, QUESTION, 1_720_000_000_000))
    const b = noteId(makeNote({ ...ANCHOR, end: 19 }, QUESTION, 1_720_000_000_000))
    expect(b).not.toBe(a)
  })

  it('sameNote is reflexive for the same note', () => {
    const a = makeNote(ANCHOR, QUESTION, 1_720_000_000_000)
    expect(sameNote(a, a)).toBe(true)
  })

  it('sameNote round-trips: equal notes agree, differing notes do not', () => {
    const a = makeNote(ANCHOR, QUESTION, 1_720_000_000_000)
    const b = makeNote(ANCHOR, QUESTION, 1_720_000_000_000)
    const c = makeNote(ANCHOR, QUESTION, 1_720_000_001_000)
    const d = makeNote({ ...ANCHOR, start: 0 }, QUESTION, 1_720_000_000_000)
    expect(sameNote(a, b)).toBe(true)
    expect(sameNote(a, c)).toBe(false)
    expect(sameNote(a, d)).toBe(false)
  })
})
