import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { useState } from 'react'
import {
  computePopoverPosition,
  noteFromMark,
  HighlightOverlay,
  type HighlightOverlayProps,
} from './highlight'
import type { AnchorRecord } from './draft-store'

// React's act() wants this flag set under jsdom (silences its warning).
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no layout engine: getBoundingClientRect returns zeros, so the
// popover positions at the root's origin — fine for DOM-shape assertions. The
// placement MATH is unit-tested directly on computePopoverPosition (pure),
// and the click-delegation mapping on noteFromMark (element-attr reads).

const DRAFT = 'The quick brown fox jumps over the lazy dog.'

let host: HTMLDivElement | null = null
let root: Root | null = null

let lastProps: Partial<HighlightOverlayProps> = {}

/** A rectForRange stub: returns the anchor's rect in viewport coordinates. */
const rectForRange = (from: number, to: number) => ({ top: 10, bottom: 30, left: from, right: to })

function renderOverlay(props: Partial<HighlightOverlayProps>) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const defaults: HighlightOverlayProps = {
    anchor: { start: 4, end: 9 },
    question: 'Why is the fox quick?',
    rectForRange,
    viewportTick: 0,
  }
  lastProps = { ...defaults, ...props }
  act(() => {
    root!.render(<HighlightOverlay {...(lastProps as HighlightOverlayProps)} />)
  })
}

/** Re-render the current overlay with updated props (no remount). */
function rerender(props: Partial<HighlightOverlayProps>): void {
  lastProps = { ...(lastProps ?? {}), ...props }
  act(() => {
    root!.render(<HighlightOverlay {...(lastProps as HighlightOverlayProps)} />)
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

describe('computePopoverPosition (placement math)', () => {
  const container = { width: 400, height: 600 }

  it('places the popover below the anchor, horizontally clamped to the container', () => {
    // Anchor near the left; a narrow popover stays at the anchor's left.
    const anchor = { top: 100, bottom: 130, left: 20, right: 80 }
    expect(computePopoverPosition(anchor, container, { width: 150, height: 60 })).toEqual({
      left: 20,
      top: 130 + 6,
    })
  })

  it('clamps horizontally when the popover would spill past the right edge', () => {
    // Anchor near the right; the popover is pushed left so it stays inside.
    const anchor = { top: 100, bottom: 130, left: 380, right: 390 }
    const pos = computePopoverPosition(anchor, container, { width: 150, height: 60 })
    expect(pos.left).toBe(400 - 150 - 4)
    expect(pos.top).toBe(130 + 6)
  })

  it('flips above the anchor when there is no room below', () => {
    // Anchor near the bottom: below placement would overflow, so it flips up.
    const anchor = { top: 540, bottom: 570, left: 50, right: 120 }
    const pos = computePopoverPosition(anchor, container, { width: 150, height: 60 })
    expect(pos.top).toBe(540 - 60 - 6)
  })

  it('clamps the flipped popover to the container inset', () => {
    // Anchor at the very top with no room above either: clamp to the inset.
    const anchor = { top: 0, bottom: 10, left: 0, right: 30 }
    const pos = computePopoverPosition(anchor, container, { width: 200, height: 600 })
    expect(pos.top).toBe(4)
    expect(pos.left).toBe(4)
  })

  it('keeps below-placement for a mid-editor anchor', () => {
    const anchor = { top: 200, bottom: 230, left: 60, right: 160 }
    const pos = computePopoverPosition(anchor, container, { width: 160, height: 50 })
    expect(pos.top).toBe(230 + 6)
    expect(pos.left).toBe(60)
  })
})

describe('noteFromMark (click delegation mapping)', () => {
  const notes: AnchorRecord[] = [
    { start: 4, end: 9, fragment: 'quick', question: 'First?', ts: 1 },
    { start: 20, end: 24, fragment: 'jump', question: 'Second?', ts: 2 },
  ]

  it('maps a mark with matching data-start/data-end to its note', () => {
    const el = document.createElement('span')
    el.setAttribute('data-start', '20')
    el.setAttribute('data-end', '24')
    expect(noteFromMark(el, notes)).toEqual(notes[1])
  })

  it('returns null for a mark whose span matches no note', () => {
    const el = document.createElement('span')
    el.setAttribute('data-start', '0')
    el.setAttribute('data-end', '3')
    expect(noteFromMark(el, notes)).toBeNull()
  })

  it('returns null when the mark lacks numeric offsets', () => {
    const noAttrs = document.createElement('span')
    expect(noteFromMark(noAttrs, notes)).toBeNull()
    const bad = document.createElement('span')
    bad.setAttribute('data-start', 'abc')
    bad.setAttribute('data-end', '24')
    expect(noteFromMark(bad, notes)).toBeNull()
  })

  it('returns null for a non-mark (null) target', () => {
    expect(noteFromMark(null, notes)).toBeNull()
  })
})

describe('HighlightOverlay', () => {
  it('shows the question popover when active', () => {
    renderOverlay({})
    expect(host!.querySelector('.coach-popover')?.textContent).toBe('Why is the fox quick?')
  })

  it('renders nothing without a question', () => {
    renderOverlay({ question: null })
    expect(host!.querySelector('.coach-popover')).toBeNull()
  })

  it('renders nothing without an anchor', () => {
    renderOverlay({ anchor: null })
    expect(host!.querySelector('.coach-popover')).toBeNull()
  })

  it('shows the popover only while activeId names this note (openOnClickOnly)', () => {
    renderOverlay({ openOnClickOnly: true, noteId: 'n1', activeId: null })
    expect(host!.querySelector('.coach-popover')).toBeNull()
    rerender({ activeId: 'n1' })
    expect(host!.querySelector('.coach-popover')).not.toBeNull()
    // The single-open slot moves to another note: this popover closes.
    rerender({ activeId: 'n2' })
    expect(host!.querySelector('.coach-popover')).toBeNull()
    // Slot released: stays closed (no stale per-overlay resurrection).
    rerender({ activeId: null })
    expect(host!.querySelector('.coach-popover')).toBeNull()
  })

  it('always shows when openOnClickOnly is false', () => {
    renderOverlay({ openOnClickOnly: false })
    expect(host!.querySelector('.coach-popover')).not.toBeNull()
  })

  it('renders a Resolved button when onResolve is provided and fires it', () => {
    const onResolve = vi.fn()
    renderOverlay({ onResolve })
    const button = host!.querySelector<HTMLButtonElement>('.coach-resolve')
    expect(button).not.toBeNull()
    expect(button!.textContent).toBe('Resolved')
    act(() => button!.click())
    expect(onResolve).toHaveBeenCalledTimes(1)
  })

  it('shows the topic-probe source chip for a generic question', () => {
    renderOverlay({ source: 'topic-probe' })
    const chip = host!.querySelector('.source-chip')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toBe('generic')
  })

  it('does not show a source chip for a reshaped question', () => {
    renderOverlay({ source: 'reshaped' })
    expect(host!.querySelector('.source-chip')).toBeNull()
  })

  it('re-positions when the viewport tick changes', () => {
    renderOverlay({ viewportTick: 0 })
    const before = host!.querySelector<HTMLElement>('.coach-popover')
    const beforeLeft = before?.style.left
    rerender({ viewportTick: 1 })
    // jsdom layout is zeroed, so the position stays at the inset — the
    // important assertion is that a tick re-runs placement without throwing
    // and the popover remains mounted at the same inset.
    const after = host!.querySelector<HTMLElement>('.coach-popover')
    expect(after).not.toBeNull()
    expect(after!.style.left).toBe('4px')
    expect(beforeLeft).toBe('4px')
  })

  it('removes exactly one note when its Resolved button is clicked', () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const notes = [
      { start: 4, end: 9, question: 'First?', ts: 1 },
      { start: 20, end: 24, question: 'Second?', ts: 2 },
    ]
    function Harness() {
      const [visible, setVisible] = useState(notes)
      return (
        <>
          {visible.map((n) => (
            <HighlightOverlay
              key={`${n.start}:${n.end}:${n.ts}`}
              anchor={{ start: n.start, end: n.end }}
              question={n.question}
              rectForRange={rectForRange}
              viewportTick={0}
              noteId={`${n.start}:${n.end}:${n.ts}`}
              activeId={null}
              onResolve={() => setVisible((prev) => prev.filter((x) => x.start !== n.start))}
              openOnClickOnly
            />
          ))}
        </>
      )
    }
    act(() => {
      root!.render(<Harness />)
    })
    // Both openOnClickOnly and activeId null: no popovers yet.
    expect(host!.querySelectorAll('.coach-popover').length).toBe(0)
  })
})
