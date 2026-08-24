import { describe, expect, it } from 'vitest'
import { EditorState, type RangeSet } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { buildHighlightSet, highlightExtension, pushHighlights } from './decorations'

/** Collect the rendered class of every mark decoration, in set order. */
function classesOf(set: RangeSet<Decoration>): string[] {
  const out: string[] = []
  set.between(0, Number.MAX_SAFE_INTEGER, (_from, _to, deco) => {
    out.push(String(deco.spec.class))
  })
  return out
}

/** Collect data-start/data-end attrs of every mark decoration. */
function attrsOf(set: RangeSet<Decoration>): Record<string, string>[] {
  const out: Record<string, string>[] = []
  set.between(0, Number.MAX_SAFE_INTEGER, (_from, _to, deco) => {
    out.push((deco.spec.attributes ?? {}) as Record<string, string>)
  })
  return out
}

/** Collect the [from, to) range of every mark decoration, in set order. */
function setRanges(set: RangeSet<Decoration>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, _deco) => {
    out.push([from, to])
  })
  return out
}

/**
 * The single DecorationSet this extension provides to the decorations facet.
 * The facet holds an array of providers (the view merges them); our field
 * contributes exactly one, so we read that first element directly.
 */
function providedSet(state: EditorState): RangeSet<Decoration> {
  const providers = state.facet(EditorView.decorations)
  expect(providers).toHaveLength(1)
  const set = providers[0]
  return typeof set === 'function' ? (set as unknown as RangeSet<Decoration>) : set
}

describe('buildHighlightSet', () => {
  it('returns an empty set for empty spans', () => {
    const set = buildHighlightSet([], 40)
    expect(set.size).toBe(0)
    expect(classesOf(set)).toEqual([])
  })

  it('clamps spans beyond the doc length to the doc end', () => {
    const set = buildHighlightSet([{ start: 0, end: 100, tone: 'question' }], 20)
    expect(classesOf(set)).toEqual(['bw-hl bw-hl-question'])
  })

  it('clamps negative starts to zero', () => {
    const set = buildHighlightSet([{ start: -5, end: 10, tone: 'note' }], 30)
    expect(classesOf(set)).toEqual(['bw-hl bw-hl-note'])
  })

  it('skips spans that collapse to empty after clamping', () => {
    const set = buildHighlightSet(
      [
        { start: 5, end: 3, tone: 'question' }, // start >= end before any clamp
        { start: 30, end: 40, tone: 'note' }, // entirely past doc end -> start == end
        { start: 0, end: 4, tone: 'sharp' },
      ],
      20,
    )
    expect(classesOf(set)).toEqual(['bw-hl bw-hl-sharp'])
  })

  it('emits one mark per span with the tone class and click-target attrs', () => {
    const set = buildHighlightSet([{ start: 2, end: 8, tone: 'question' }], 30)
    expect(classesOf(set)).toEqual(['bw-hl bw-hl-question'])
    expect(attrsOf(set)).toEqual([{ 'data-start': '2', 'data-end': '8' }])
  })

  it('emits multiple spans sorted by start offset', () => {
    const set = buildHighlightSet(
      [
        { start: 12, end: 16, tone: 'note' },
        { start: 0, end: 4, tone: 'question' },
        { start: 6, end: 10, tone: 'sharp' },
      ],
      30,
    )
    expect(classesOf(set)).toEqual(['bw-hl bw-hl-question', 'bw-hl bw-hl-sharp', 'bw-hl bw-hl-note'])
  })

  it('tolerates adjacent (non-overlapping) spans', () => {
    const set = buildHighlightSet(
      [
        { start: 0, end: 5, tone: 'note' },
        { start: 5, end: 9, tone: 'question' },
      ],
      30,
    )
    expect(classesOf(set)).toEqual(['bw-hl bw-hl-note', 'bw-hl bw-hl-question'])
  })
})

describe('highlightExtension effect round-trip', () => {
  it('starts empty and pushes a fresh set through the decorations facet', () => {
    const state = EditorState.create({ extensions: [highlightExtension()] })
    expect(providedSet(state).size).toBe(0)

    const next = state
      .update({
        effects: pushHighlights.of(buildHighlightSet([{ start: 1, end: 5, tone: 'note' }], 20)),
      })
      .state

    expect(classesOf(providedSet(next))).toEqual(['bw-hl bw-hl-note'])
  })

  it('replaces the previous set on a later push', () => {
    const state = EditorState.create({ extensions: [highlightExtension()] })
    const s1 = state
      .update({ effects: pushHighlights.of(buildHighlightSet([{ start: 0, end: 3, tone: 'note' }], 20)) })
      .state
    const s2 = s1
      .update({ effects: pushHighlights.of(buildHighlightSet([{ start: 7, end: 9, tone: 'sharp' }], 20)) })
      .state

    expect(classesOf(providedSet(s2))).toEqual(['bw-hl bw-hl-sharp'])
  })

  it('maps marks across a doc-changing transaction without any push', () => {
    const state = EditorState.create({ doc: 'hello world', extensions: [highlightExtension()] })
    const withHl = state
      .update({ effects: pushHighlights.of(buildHighlightSet([{ start: 2, end: 5, tone: 'note' }], 11)) })
      .state
    expect(setRanges(providedSet(withHl))).toEqual([[2, 5]])

    // Insert 2 chars at the start with no push: ranges shift +2, count constant.
    const mapped = withHl.update({ changes: { from: 0, insert: 'ab' } }).state
    expect(setRanges(providedSet(mapped))).toEqual([[4, 7]])
    expect(providedSet(mapped).size).toBe(1)
  })

  it('a later push wholesale replaces the mapped set', () => {
    const state = EditorState.create({ doc: 'hello world', extensions: [highlightExtension()] })
    const withHl = state
      .update({ effects: pushHighlights.of(buildHighlightSet([{ start: 2, end: 5, tone: 'note' }], 11)) })
      .state
    const mapped = withHl.update({ changes: { from: 0, insert: 'x' } }).state
    expect(setRanges(providedSet(mapped))).toEqual([[3, 6]])

    // A later authoritative push discards the mapped set wholesale.
    const pushed = mapped
      .update({
        effects: pushHighlights.of(buildHighlightSet([{ start: 8, end: 11, tone: 'sharp' }], 12)),
      })
      .state
    expect(classesOf(providedSet(pushed))).toEqual(['bw-hl bw-hl-sharp'])
    expect(setRanges(providedSet(pushed))).toEqual([[8, 11]])
  })

  it('effects-only transactions leave the set untouched', () => {
    const state = EditorState.create({ doc: 'hello', extensions: [highlightExtension()] })
    const withHl = state
      .update({ effects: pushHighlights.of(buildHighlightSet([{ start: 0, end: 3, tone: 'note' }], 5)) })
      .state

    // A non-doc, non-highlight transaction (e.g. a scroll effect) must not
    // map or drop the held set.
    const scrolled = withHl.update({ effects: EditorView.scrollIntoView(3) }).state
    expect(setRanges(providedSet(scrolled))).toEqual([[0, 3]])
    expect(classesOf(providedSet(scrolled))).toEqual(['bw-hl bw-hl-note'])
  })
})
