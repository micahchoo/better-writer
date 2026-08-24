import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { InboxPanel, type InboxPanelProps } from './inbox-panel'
import type { AnchorRecord } from './draft-store'

// React's act() wants this flag set under jsdom (silences its warning).
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement | null = null
let root: Root | null = null

function makeNote(overrides: Partial<AnchorRecord> = {}): AnchorRecord {
  return {
    start: 0,
    end: 5,
    fragment: 'some fragment',
    question: 'Why?',
    ts: 1,
    ...overrides,
  }
}

function renderPanel(props: Partial<InboxPanelProps> = {}) {
  const onFocusNote = vi.fn()
  const onResolveNote = vi.fn()
  const defaults: InboxPanelProps = {
    notes: [],
    focusNoteId: null,
    onFocusNote,
    onResolveNote,
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(<InboxPanel {...defaults} {...props} />)
  })
  return { onFocusNote, onResolveNote }
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
    root = null
  }
  if (host) {
    host.remove()
    host = null
  }
})

describe('InboxPanel', () => {
  it('renders one row per note, in array order', () => {
    const notes = [
      makeNote({ question: 'First?', fragment: 'one', ts: 1 }),
      makeNote({ question: 'Second?', fragment: 'two', ts: 2 }),
      makeNote({ question: 'Third?', fragment: 'three', ts: 3 }),
    ]
    renderPanel({ notes })
    const rows = host!.querySelectorAll('.inbox-row')
    expect(rows.length).toBe(3)
    const questions = [...host!.querySelectorAll('.inbox-question')].map((el) => el.textContent)
    expect(questions).toEqual(['First?', 'Second?', 'Third?'])
    const fragments = [...host!.querySelectorAll('.inbox-fragment')].map((el) => el.textContent)
    expect(fragments).toEqual(['one', 'two', 'three'])
  })

  it('exposes each row body as a real, tab-reachable native button', () => {
    const notes = [
      makeNote({ question: 'First?', ts: 1 }),
      makeNote({ question: 'Second?', ts: 2 }),
    ]
    renderPanel({ notes })
    const mains = host!.querySelectorAll<HTMLButtonElement>('.inbox-row-main')
    expect(mains.length).toBe(2)
    for (const main of mains) {
      // A native <button type="button"> is focusable via Tab and activates
      // on Enter/Space by default — the keyboard path S4-3 was missing.
      expect(main.tagName).toBe('BUTTON')
      expect(main.type).toBe('button')
    }
    // Row bodies stay inside valid listitems for the parent list semantics.
    const items = host!.querySelectorAll('.inbox-row[role="listitem"]')
    expect(items.length).toBe(2)
    expect(items[0]!.querySelector('.inbox-row-main')).not.toBeNull()
  })

  it('fires onFocusNote with that note when a row body is activated', () => {
    const notes = [
      makeNote({ question: 'First?', ts: 1 }),
      makeNote({ question: 'Second?', ts: 2 }),
    ]
    const { onFocusNote } = renderPanel({ notes })
    // Activating a native button is the click path both mouse and keyboard
    // (Enter/Space) route through in a real browser.
    const mains = host!.querySelectorAll<HTMLButtonElement>('.inbox-row-main')
    act(() => mains[1]!.click())
    expect(onFocusNote).toHaveBeenCalledTimes(1)
    expect(onFocusNote).toHaveBeenCalledWith(notes[1])
  })

  it('Resolved calls onResolveNote with that note and not onFocusNote', () => {
    const notes = [
      makeNote({ question: 'First?', ts: 1 }),
      makeNote({ question: 'Second?', ts: 2 }),
    ]
    const { onFocusNote, onResolveNote } = renderPanel({ notes })
    const buttons = host!.querySelectorAll<HTMLButtonElement>('.coach-resolve')
    expect(buttons.length).toBe(2)
    act(() => buttons[1]!.click())
    expect(onResolveNote).toHaveBeenCalledTimes(1)
    expect(onResolveNote).toHaveBeenCalledWith(notes[1])
    expect(onFocusNote).not.toHaveBeenCalled()
  })

  it('renders a quiet empty-state paragraph when there are no notes', () => {
    renderPanel({ notes: [] })
    const empty = host!.querySelector('.inbox-empty')
    expect(empty).not.toBeNull()
    expect(empty!.textContent).toBe('No pinned questions.')
    expect(host!.querySelector('.inbox-row')).toBeNull()
  })
})
