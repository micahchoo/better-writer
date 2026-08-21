import { describe, expect, it } from 'vitest'
import { textWindow } from './text-window'

const CURSOR = (text: string) => `[CURSOR START]\n${text}\n[CURSOR END]`

describe('textWindow', () => {
  it('marks the cursor paragraph in a single-block document', () => {
    expect(textWindow('Hello world.', 0)).toBe(CURSOR('Hello world.'))
  })

  it('marks the block containing the cursor, with one before and two after', () => {
    const doc = 'A.\n\nB.\n\nC.\n\nD.\n\nE.'
    expect(textWindow(doc, doc.indexOf('C'))).toBe(`B.\n\n${CURSOR('C.')}\n\nD.\n\nE.`)
  })

  it('marks a whole multi-line paragraph, not just the cursor line', () => {
    const doc = 'Para line one.\nPara line two.\n\nNext block.'
    expect(textWindow(doc, doc.indexOf('line two'))).toBe(
      `${CURSOR('Para line one.\nPara line two.')}\n\nNext block.`,
    )
  })

  it('stops the window at a heading — nothing from the far side', () => {
    const doc = 'Before one.\n\nBefore two.\n\n## Middle\n\nCurrent.\n\nAfter one.\n\nAfter two.'
    expect(textWindow(doc, doc.indexOf('Current'))).toBe(`${CURSOR('Current.')}\n\nAfter one.\n\nAfter two.`)
  })

  it('stops before-blocks at a heading', () => {
    const doc = 'Before.\n\n## Heading\n\nCurrent.'
    expect(textWindow(doc, doc.indexOf('Current'))).toBe(CURSOR('Current.'))
  })

  it('treats a heading as the cursor block when the cursor is on it', () => {
    const doc = 'Lead-in.\n\n## Title\n\nFollow-on.'
    expect(textWindow(doc, doc.indexOf('## Title'))).toBe(
      `Lead-in.\n\n${CURSOR('## Title')}\n\nFollow-on.`,
    )
  })

  it('keeps a cursor block fully isolated between two headings', () => {
    const doc = '# Top\n\nBody one.\n\n# Next\n\nBody two.'
    expect(textWindow(doc, doc.indexOf('Body one'))).toBe(CURSOR('Body one.'))
  })

  it('treats each list item as a separate block', () => {
    const doc = '- one\n- two\n- three'
    expect(textWindow(doc, doc.indexOf('- two'))).toBe(`- one\n\n${CURSOR('- two')}\n\n- three`)
  })

  it('keeps a list item continuation attached to its item', () => {
    const doc = '- one\n  continuation\n- two'
    expect(textWindow(doc, doc.indexOf('- two'))).toBe(`- one\n  continuation\n\n${CURSOR('- two')}`)
  })

  it('treats ordered list items as separate blocks', () => {
    const doc = '1. first\n2. second'
    expect(textWindow(doc, doc.indexOf('2. second'))).toBe(`1. first\n\n${CURSOR('2. second')}`)
  })

  it('handles a cursor on an empty line by taking the next block', () => {
    const doc = 'First.\n\nSecond.'
    const cursorAt = doc.indexOf('First.') + 'First.'.length + 1 // on the blank line
    expect(textWindow(doc, cursorAt)).toBe(`First.\n\n${CURSOR('Second.')}`)
  })

  it('handles a cursor at the very end of the document', () => {
    const doc = 'Only para.'
    expect(textWindow(doc, doc.length)).toBe(CURSOR('Only para.'))
  })

  it('handles a cursor on leading blank lines', () => {
    const doc = '\n\nFirst.'
    expect(textWindow(doc, 1)).toBe(CURSOR('First.'))
  })

  it('returns an empty string for an empty document', () => {
    expect(textWindow('', 0)).toBe('')
    expect(textWindow('\n\n', 1)).toBe('')
  })

  it('handles CRLF line endings without corrupting block text', () => {
    const doc = 'One.\r\n\r\nTwo.'
    expect(textWindow(doc, doc.indexOf('Two'))).toBe(`One.\n\n${CURSOR('Two.')}`)
  })
})
