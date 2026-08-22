import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useState, type RefObject } from 'react'
import { HighlightOverlay, type HighlightOverlayProps } from './highlight'

// React's act() wants this flag set under jsdom (silences its warning).
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no layout engine: getBoundingClientRect returns zeros, so the
// overlay measures a 0×0 layer — which is fine for DOM-shape assertions. The
// component also guards a missing ResizeObserver, so no polyfill is needed.

const DRAFT = 'The quick brown fox jumps over the lazy dog.'

let host: HTMLDivElement | null = null
let root: Root | null = null

function renderOverlay(props: Partial<HighlightOverlayProps>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const textarea = document.createElement('textarea')
  const defaults: HighlightOverlayProps = {
    draft: DRAFT,
    anchor: { start: 4, end: 9 },
    question: 'Why is the fox quick?',
    cursorBlock: null,
    textareaRef: { current: textarea } as RefObject<HTMLTextAreaElement>,
  }
  act(() => {
    root!.render(<HighlightOverlay {...defaults} {...props} />)
  })
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

describe('HighlightOverlay', () => {
  it('paints the anchor span and shows the question popover', () => {
    renderOverlay({})
    expect(host!.querySelector('.coach-highlight-span')?.textContent).toBe('quick')
    expect(host!.querySelector('.coach-popover')?.textContent).toBe('Why is the fox quick?')
  })

  it('mirrors the full draft plus the trailing newline the textarea keeps', () => {
    renderOverlay({})
    const code = host!.querySelector('.coach-highlight-mirror code')
    expect(code?.textContent).toBe(`${DRAFT}\n`)
  })

  it('falls back to the cursor block when the anchor is null', () => {
    renderOverlay({ anchor: null, cursorBlock: { start: 10, end: 15 } })
    expect(host!.querySelector('.coach-highlight-span')?.textContent).toBe('brown')
  })

  it('renders nothing without a question', () => {
    renderOverlay({ question: null })
    expect(host!.querySelector('.coach-highlight-layer')).toBeNull()
  })

  it('renders nothing when neither anchor nor cursor block exists', () => {
    renderOverlay({ anchor: null, cursorBlock: null })
    expect(host!.querySelector('.coach-highlight-layer')).toBeNull()
  })

  it('does not throw when the textarea is unmounted', () => {
    expect(() => renderOverlay({ textareaRef: { current: null } })).not.toThrow()
    // No mirror or popover without a textarea to measure against.
    expect(host!.querySelector('.coach-highlight-span')).toBeNull()
    expect(host!.querySelector('.coach-popover')).toBeNull()
  })

  it('renders a Resolved button in the popover when onResolve is provided', () => {
    const onResolve = vi.fn()
    renderOverlay({ onResolve })
    const button = host!.querySelector<HTMLButtonElement>('.coach-resolve')
    expect(button).not.toBeNull()
    expect(button!.textContent).toBe('Resolved')
    act(() => button!.click())
    expect(onResolve).toHaveBeenCalledTimes(1)
  })

  it('keeps the popover to just the question without onResolve', () => {
    renderOverlay({})
    expect(host!.querySelector('.coach-resolve')).toBeNull()
    expect(host!.querySelector('.coach-popover')?.textContent).toBe('Why is the fox quick?')
  })

  it('renders one overlay per note when multiple instances are mounted', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const textarea = document.createElement('textarea')
    const base: HighlightOverlayProps = {
      draft: DRAFT,
      anchor: null,
      question: null,
      cursorBlock: null,
      textareaRef: { current: textarea } as RefObject<HTMLTextAreaElement>,
    }
    act(() => {
      root!.render(
        <>
          <HighlightOverlay {...base} anchor={{ start: 4, end: 9 }} question="Why is the fox quick?" />
          <HighlightOverlay {...base} anchor={{ start: 20, end: 24 }} question="Where does the fox jump?" />
        </>,
      )
    })
    const layers = host!.querySelectorAll('.coach-highlight-layer')
    const spans = host!.querySelectorAll('.coach-highlight-span')
    const popovers = host!.querySelectorAll('.coach-popover')
    expect(layers.length).toBe(2)
    expect(spans.length).toBe(2)
    expect(spans[0]!.textContent).toBe('quick')
    expect(spans[1]!.textContent).toBe('jump')
    expect(popovers.length).toBe(2)
    expect(popovers[0]!.textContent).toBe('Why is the fox quick?')
    expect(popovers[1]!.textContent).toBe('Where does the fox jump?')
  })

  it('removes exactly one note when its Resolved button is clicked', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const textarea = document.createElement('textarea')
    const base = {
      draft: DRAFT,
      cursorBlock: null as { start: number; end: number } | null,
      textareaRef: { current: textarea } as RefObject<HTMLTextAreaElement>,
    }
    const notes = [
      { start: 4, end: 9, question: 'First?' },
      { start: 20, end: 24, question: 'Second?' },
    ]
    function Harness() {
      const [visible, setVisible] = useState(notes)
      return (
        <>
          {visible.map((n) => (
            <HighlightOverlay
              key={n.start}
              {...base}
              anchor={{ start: n.start, end: n.end }}
              question={n.question}
              onResolve={() => setVisible((prev) => prev.filter((x) => x.start !== n.start))}
            />
          ))}
        </>
      )
    }
    act(() => {
      root!.render(<Harness />)
    })
    expect(host!.querySelectorAll('.coach-popover').length).toBe(2)
    const buttons = host!.querySelectorAll<HTMLButtonElement>('.coach-resolve')
    act(() => buttons[1]!.click())
    expect(host!.querySelectorAll('.coach-popover').length).toBe(1)
    expect(host!.querySelector('.coach-popover')?.textContent).toBe('First?Resolved')
    expect(host!.querySelector('.coach-highlight-span')?.textContent).toBe('quick')
  })
})
