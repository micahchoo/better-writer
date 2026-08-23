import { describe, expect, it } from 'vitest'
import {
  CURSOR_END,
  CURSOR_START,
  buildAskWindow,
  cursorWindow,
  partitionSections,
  splitBlocks,
} from './text-window'

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

describe('partitionSections', () => {
  it('returns [] for empty input', () => {
    expect(partitionSections([])).toEqual([])
  })

  it('a heading mid-list starts a new section', () => {
    const blocks = splitBlocks('- first\n- second\n\n# Head\n\nafter')
    expect(partitionSections(blocks).map((s) => s.map((b) => b.text))).toEqual([
      ['- first', '- second'],
      ['# Head', 'after'],
    ])
  })

  it('a pre-heading intro paragraph is its own section', () => {
    const blocks = splitBlocks('intro\n\n# Head\n\ntail')
    expect(partitionSections(blocks).map((s) => s.map((b) => b.text))).toEqual([
      ['intro'],
      ['# Head', 'tail'],
    ])
  })

  it('consecutive headings each open a section', () => {
    const blocks = splitBlocks('# One\n\n# Two\n\nbody')
    expect(partitionSections(blocks).map((s) => s.map((b) => b.text))).toEqual([
      ['# One'],
      ['# Two', 'body'],
    ])
  })

  it('a thematic break splits like a heading', () => {
    const blocks = splitBlocks('before\n\n---\n\nafter')
    expect(partitionSections(blocks).map((s) => s.map((b) => b.text))).toEqual([
      ['before'],
      ['---', 'after'],
    ])
  })

  it('leaves offsets untouched', () => {
    const blocks = splitBlocks('intro\n\n# Head\n\ntail')
    const sections = partitionSections(blocks)
    expect(sections.flat()).toEqual(blocks)
    expect(sections.flat().map((b) => [b.start, b.end])).toEqual(
      blocks.map((b) => [b.start, b.end]),
    )
  })
})

describe('cursorWindow', () => {
  it('returns null for empty input', () => {
    expect(cursorWindow([], 0)).toBeNull()
  })

  it('centers the caret block with one neighbor on each side', () => {
    const blocks = splitBlocks('A.\n\nB.\n\nC.')
    expect(cursorWindow(blocks, blocks[1].start + 1)).toEqual({
      texts: ['A.', 'B.', 'C.'],
      markIndex: 1,
    })
  })

  it('a caret in a gap takes the next block and centers it', () => {
    const blocks = splitBlocks('A.\n\nB.\n\nC.\n\nD.')
    const win = cursorWindow(blocks, blocks[2].start - 1)
    expect(win).toEqual({ texts: ['B.', 'C.', 'D.'], markIndex: 1 })
  })

  it('a caret past the end takes the last block with a backward-biased window', () => {
    const blocks = splitBlocks('A.\n\nB.\n\nC.')
    expect(cursorWindow(blocks, 1000)).toEqual({ texts: ['B.', 'C.'], markIndex: 1 })
  })

  it('clips at the first-block edge', () => {
    const blocks = splitBlocks('A.\n\nB.\n\nC.')
    expect(cursorWindow(blocks, 0)).toEqual({ texts: ['A.', 'B.'], markIndex: 0 })
  })

  it('clips at the last-block edge', () => {
    const blocks = splitBlocks('A.\n\nB.\n\nC.')
    expect(cursorWindow(blocks, blocks[2].end)).toEqual({ texts: ['B.', 'C.'], markIndex: 1 })
  })
})
describe('marker tokens', () => {
  it('exports the exact wire tokens', () => {
    expect(CURSOR_START).toBe('[CURSOR START]')
    expect(CURSOR_END).toBe('[CURSOR END]')
  })
})
