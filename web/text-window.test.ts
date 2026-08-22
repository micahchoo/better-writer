import { describe, expect, it } from 'vitest'
import { CURSOR_END, CURSOR_START, buildAskWindow, findCursorEnvelope } from './text-window'

const unmarked = (marked: string) => marked.split(CURSOR_START).join('').split(CURSOR_END).join('')

describe('buildAskWindow', () => {
  it('joins block texts with blank lines', () => {
    expect(buildAskWindow(['A.', 'B.', 'C.'], null)).toBe('A.\n\nB.\n\nC.')
  })

  it('wraps the marked block in cursor markers', () => {
    expect(buildAskWindow(['A.', 'B.', 'C.'], 1)).toBe(`A.\n\n${CURSOR_START}\nB.\n${CURSOR_END}\n\nC.`)
  })

  it('marks the first and last blocks too', () => {
    expect(buildAskWindow(['A.', 'B.'], 0)).toBe(`${CURSOR_START}\nA.\n${CURSOR_END}\n\nB.`)
    expect(buildAskWindow(['A.', 'B.'], 1)).toBe(`A.\n\n${CURSOR_START}\nB.\n${CURSOR_END}`)
  })

  it('handles a single-block window', () => {
    expect(buildAskWindow(['A.'], 0)).toBe(`${CURSOR_START}\nA.\n${CURSOR_END}`)
  })

  it('produces an empty string for an empty window', () => {
    expect(buildAskWindow([], null)).toBe('')
  })
})

describe('findCursorEnvelope', () => {
  it('reports the marked block span as offsets into the unmarked window', () => {
    const marked = `A.\n\n${CURSOR_START}\nB.\n${CURSOR_END}\n\nC.`
    const envelope = findCursorEnvelope(marked)
    expect(envelope).not.toBeNull()
    expect(unmarked(marked).slice(envelope!.start, envelope!.end)).toBe('\nB.\n')
  })

  it('covers only the marked block, not its neighbors', () => {
    // A sweep window: three blocks, only the middle marked.
    const marked = `Alpha beta.\n\n${CURSOR_START}\nDelta zeta.\n${CURSOR_END}\n\nEta theta.`
    const envelope = findCursorEnvelope(marked)
    expect(envelope).not.toBeNull()
    const text = unmarked(marked)
    expect(text.slice(envelope!.start, envelope!.end)).toBe('\nDelta zeta.\n')
  })

  it('covers a single-block marked window in full', () => {
    const marked = `${CURSOR_START}\nOnly para.\n${CURSOR_END}`
    const envelope = findCursorEnvelope(marked)
    expect(envelope).not.toBeNull()
    const text = unmarked(marked)
    expect(envelope).toEqual({ start: 0, end: text.length })
    expect(text.slice(envelope!.start, envelope!.end)).toBe('\nOnly para.\n')
  })

  it('returns null when no marker is present', () => {
    expect(findCursorEnvelope('A.\n\nB.\n\nC.')).toBeNull()
  })

  it('returns null when only one marker is present', () => {
    expect(findCursorEnvelope(`${CURSOR_START}\nA.`)).toBeNull()
    expect(findCursorEnvelope(`A.\n${CURSOR_END}`)).toBeNull()
  })

  it('returns null when the END marker precedes the START marker', () => {
    expect(findCursorEnvelope(`${CURSOR_END}\nA.\n${CURSOR_START}`)).toBeNull()
  })
})

describe('marker tokens', () => {
  it('exports the exact wire tokens', () => {
    expect(CURSOR_START).toBe('[CURSOR START]')
    expect(CURSOR_END).toBe('[CURSOR END]')
  })
})
