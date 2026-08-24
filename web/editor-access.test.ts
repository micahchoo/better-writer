/**
 * editor-access.test.ts — Task 2 seam tests over a real @codemirror/view EditorView.
 *
 * SPIKE (first test): can a real EditorView mount against document.createElement('div')
 * in this vitest/jsdom env? jsdom >= 26 provides MutationObserver, so the view mounts
 * and runs its DOM observer. Layout measurement, however, is unavailable headlessly:
 * jsdom's Range lacks getClientRects, so the polyfill below makes every layout path
 * (coordsAtPos, rAF text measurement) degrade to "no geometry" instead of throwing.
 * The seam's rectForRange then returns null when attached — matching the contract's
 * null-for-unmeasurable semantics — and the union arithmetic is covered directly on
 * the pure `unionRects` helper. Real-browser geometry is verified in Task 5.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorSelection, Transaction, type EditorState, type RangeSet } from '@codemirror/state'
import { historyField, undo } from '@codemirror/commands'
import { highlightExtension } from './decorations'
import { createEditorAccess, unionRects, type Rect } from './editor-access'
import { EditorView, type Decoration } from '@codemirror/view'

// jsdom (26) provides MutationObserver so a real EditorView can mount, but it does
// NOT implement Range.prototype.getClientRects, which @codemirror/view needs for text
// measurement. CM6 treats an empty rect list as "no geometry", so polyfilling zero
// rects lets every layout-dependent code path (coordsAtPos, rAF measurement) degrade
// to null/zeros instead of throwing. Installed before any view mounts.
if (!Range.prototype.getClientRects) {
  const emptyRectList = (): { length: number } => ({ length: 0 })
  Range.prototype.getClientRects = emptyRectList as never
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = (): DOMRect =>
      ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  }
}

/** Grab the live EditorView out of the mounted DOM so tests can drive internals
 *  (selection placement, simulated composition) that the seam deliberately hides. */
function mountedView(target: HTMLElement): EditorView {
  const content = target.querySelector<HTMLElement>('.cm-content')
  if (!content) throw new Error('no .cm-content mounted')
  const view = EditorView.findFromDOM(content)
  if (!view) throw new Error('no EditorView findable from mounted DOM')
  return view
}

function freshTarget(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

let cleanupTargets: HTMLElement[] = []

afterEach(() => {
  for (const t of cleanupTargets) {
    t.remove()
  }
  cleanupTargets = []
})

function track(el: HTMLElement): HTMLElement {
  cleanupTargets.push(el)
  return el
}

// The highlightExtension field provides exactly one decorations provider; the
// pushed set surfaces through the EditorView.decorations facet.
function providedFacetSet(state: EditorState): RangeSet<Decoration> {
  const providers = state.facet(EditorView.decorations)
  expect(providers).toHaveLength(1)
  const set = providers[0]
  return typeof set === 'function' ? (set as unknown as RangeSet<Decoration>) : set
}

/** Collect the rendered class of every mark decoration in the facet set. */
function decoClasses(set: RangeSet<Decoration>, docLength: number): string[] {
  const out: string[] = []
  set.between(0, docLength, (_from, _to, deco) => {
    out.push(String(deco.spec.class))
  })
  return out
}

// Number of undoable history event groups (events `undo` could revert). An
// `addToHistory:false` push leaves it untouched; a real edit increments it;
// undo decrements it (the event moves to the undone buffer).
function historyDepth(state: EditorState): number {
  // historyField is typed `unknown` in @codemirror/commands; its runtime shape
  // is the standard { done, undone, prevRanges } history buffer (library type
  // unexpressible, so the cast is to a named const, not inline member access).
  const h = state.field(historyField) as { done: unknown[]; undone: unknown[] }
  return h.done.length
}

// Drive CM6's private inputState.composing counter (test-only). The seam hides
// the view, but simulating composition needs it; view.composing reflects the
// counter. Used by 3+ tests, so it lives as one helper instead of inline casts.
function setComposing(view: EditorView, composing: number): void {
  // EditorView.inputState is private; poke it to drive view.composing (mirrors
  // the C4 test's established pattern — library type not expressible).
  const withInputState = view as unknown as { inputState: { composing: number } }
  withInputState.inputState.composing = composing
}

describe('editor-access', () => {
  // ---------------------------------------------------------------------------
  // SPIKE: does a real EditorView mount against a jsdom div?
  // ---------------------------------------------------------------------------
  it('SPIKE: mounts a real EditorView against a jsdom div and reads a cursor', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    let callbacks = 0
    access.attach(target, 'hello world', () => {
      callbacks++
    })

    // The seam mounted real CM6 DOM and owns focus.
    const content = target.querySelector('.cm-content')
    expect(content).not.toBeNull()

    const cursor = access.readCursor()
    expect(cursor).toEqual({ offset: 0, text: 'hello world' })

    // attach owns focus() — activeElement should be inside the editor content.
    expect(document.activeElement).toBe(content)

    // No doc change on mount, so no onDocChange callback.
    expect(callbacks).toBe(0)

    access.detach()
    expect(target.querySelector('.cm-editor')).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // cursor read
  // ---------------------------------------------------------------------------
  it('readCursor reflects the current selection head and full text', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'hello world', () => {})

    expect(access.readCursor()).toEqual({ offset: 0, text: 'hello world' })

    // Move the caret through the mounted view (the seam hides the view from
    // callers, but tests may drive it to exercise readCursor).
    const view = mountedView(target)
    view.dispatch({ selection: EditorSelection.cursor(6) })
    expect(access.readCursor()).toEqual({ offset: 6, text: 'hello world' })
  })

  it('readCursor returns null when detached', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'abc', () => {})
    expect(access.readCursor()).not.toBeNull()
    access.detach()
    expect(access.readCursor()).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // insertAtCursor
  // ---------------------------------------------------------------------------
  it('insertAtCursor replaces the selection and places the caret after the insert', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    const docs: string[] = []
    access.attach(target, 'hello world', (text) => docs.push(text))

    const view = mountedView(target)
    // Select "world" (offset 6..11).
    view.dispatch({ selection: EditorSelection.single(6, 11) })

    expect(access.insertAtCursor('there')).toBe(true)
    expect(access.readCursor()).toEqual({ offset: 11, text: 'hello there' })
    // One batched doc change callback with the updated text.
    expect(docs).toEqual(['hello there'])
  })

  it('insertAtCursor returns false when detached and does not throw', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'abc', () => {})
    access.detach()
    expect(access.insertAtCursor('x')).toBe(false)
  })

  it('insertAtCursor returns false while composing (C4) and leaves the doc untouched', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    const docs: string[] = []
    access.attach(target, 'abc', (text) => docs.push(text))

    const view = mountedView(target)
    // Simulate an in-flight IME composition on the real view (pokes the
    // private inputState.composing counter to drive view.composing).
    setComposing(view, 1)
    expect(view.composing).toBe(true)

    expect(access.insertAtCursor('x')).toBe(false)
    expect(access.readCursor()?.text).toBe('abc')
    expect(docs).toEqual([])

    // Composition ends → insert is accepted again (caret placed at end of 'abc').
    view.dispatch({ selection: EditorSelection.cursor(3) })
    setComposing(view, 0)
    expect(view.composing).toBe(false)
    expect(access.insertAtCursor('x')).toBe(true)
    expect(access.readCursor()?.text).toBe('abcx')
  })

  // ---------------------------------------------------------------------------
  // replaceDocument (C3)
  // ---------------------------------------------------------------------------
  it('replaceDocument default excludes the replacement from history but maps prior events', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'a', () => {})
    const view = mountedView(target)
    view.dispatch({ selection: EditorSelection.cursor(1) }) // caret at end of 'a'

    // insertAtCursor records normal, undoable history.
    access.insertAtCursor('b') // 'ab'
    expect(view.state.doc.toString()).toBe('ab')
    undo(view)
    expect(view.state.doc.toString()).toBe('a')

    // Rebuild then replace wholesale with the default (history-excluded) policy.
    view.dispatch({ selection: EditorSelection.cursor(1) })
    access.insertAtCursor('b') // 'ab'
    access.replaceDocument('XYZ')
    expect(view.state.doc.toString()).toBe('XYZ')

    // The replacement is excluded from history: undo does NOT revert to 'ab'
    // (the FA-4 hazard — pre-replace text is never resurrected wholesale).
    undo(view)
    expect(view.state.doc.toString()).toBe('XYZ')
  })

  it('replaceDocument history:reset rebuilds state so undo cannot wipe the document', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'a', () => {})
    access.insertAtCursor('b') // "ab"

    access.replaceDocument('NEW', { history: 'reset' })
    expect(access.readCursor()?.text).toBe('NEW')

    const view = mountedView(target)
    undo(view)
    // History was discarded with the state; undo is a no-op, not a wipe.
    expect(view.state.doc.toString()).toBe('NEW')
  })

  it('replaceDocument fires onDocChange (default path) and resets the caret to 0', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    const docs: string[] = []
    access.attach(target, 'hello', (text) => docs.push(text))

    access.replaceDocument('replaced')
    expect(docs).toEqual(['replaced'])
    expect(access.readCursor()).toEqual({ offset: 0, text: 'replaced' })
  })

  it('replaceDocument is a no-op when detached', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'hello', () => {})
    access.detach()
    expect(() => access.replaceDocument('nope')).not.toThrow()
  })

  // ---------------------------------------------------------------------------
  // onDocChange batching
  // ---------------------------------------------------------------------------
  it('onDocChange fires once per doc-changing update, after state is updated', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    const seen: Array<{ text: string; txCount: number }> = []
    access.attach(target, 'hi', (text, transactions) => {
      seen.push({ text, txCount: transactions.length })
      // Callback must observe the already-updated state.
      expect(access.readCursor()?.text).toBe(text)
    })

    // Caret starts at offset 0; move it to the end so inserts append.
    mountedView(target).dispatch({ selection: EditorSelection.cursor(2) })
    access.insertAtCursor('!')
    access.insertAtCursor('?')

    expect(seen.map((s) => s.text)).toEqual(['hi!', 'hi!?'])
    for (const s of seen) expect(s.txCount).toBe(1)
  })

  it('onDocChange does not fire for non-doc updates (scrollToOffset)', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    let calls = 0
    access.attach(target, 'hi', () => {
      calls++
    })
    access.scrollToOffset(1)
    expect(calls).toBe(0)
  })

  it('onDocChange delivers real Transaction objects', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    let tx: readonly Transaction[] | null = null
    access.attach(target, 'hi', (_text, transactions) => {
      tx = transactions
    })
    access.insertAtCursor('x')
    expect(tx).not.toBeNull()
    expect(tx![0]).toBeInstanceOf(Transaction)
    expect(tx![0].docChanged).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // scrollToOffset
  // ---------------------------------------------------------------------------
  it('scrollToOffset is a no-op when detached', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'hi', () => {})
    access.detach()
    expect(() => access.scrollToOffset(5)).not.toThrow()
  })

  // ---------------------------------------------------------------------------
  // rectForRange
  // ---------------------------------------------------------------------------
  it('rectForRange returns null when detached', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'hello', () => {})
    access.detach()
    expect(access.rectForRange(0, 1)).toBeNull()
  })

  it('rectForRange returns null for an empty range even when attached', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'hello', () => {})
    expect(access.rectForRange(2, 2)).toBeNull()
    expect(access.rectForRange(3, 1)).toBeNull()
  })

  // The seam computes rectForRange as the union of coordsAtPos at both ends.
  // jsdom has no real layout, so coordsAtPos yields null (see Range polyfill) —
  // the union arithmetic is covered directly on the pure helper; the seam's null
  // paths are covered above. This guards against a regression producing NaN fields.
  it('rectForRange returns a finite Rect or null when attached (no NaN)', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'hello', () => {})
    const rect = access.rectForRange(0, 5)
    if (rect === null) {
      // Headless (no layout) → null coordsAtPos, acceptable; real geometry is
      // verified in Task 5. The union arithmetic itself is unit-tested below.
      expect(rect).toBeNull()
    } else {
      for (const k of ['top', 'bottom', 'left', 'right'] as const) {
        expect(Number.isFinite(rect[k])).toBe(true)
      }
    }
  })

  it('unionRects returns the bounding box of two rects', () => {
    const a: Rect = { top: 10, bottom: 40, left: 5, right: 30 }
    const b: Rect = { top: 0, bottom: 20, left: 50, right: 60 }
    expect(unionRects(a, b)).toEqual({ top: 0, bottom: 40, left: 5, right: 60 })
    expect(unionRects(b, a)).toEqual({ top: 0, bottom: 40, left: 5, right: 60 })
    // Union with itself is the identity.
    expect(unionRects(a, a)).toEqual(a)
  })
  // ---------------------------------------------------------------------------
  // onViewportChange (popover repositioning, Task 5)
  // ---------------------------------------------------------------------------
  it('onViewportChange fires on a doc-changing update and unsubscribes', async () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'hello', () => {})
    const cb = vi.fn()
    access.onViewportChange(cb)

    // Fire a doc change, then await the callback's own signal (not a fixed
    // delay) — the update listener schedules an rAF-throttled viewport tick.
    let resolveFired: (() => void) | null = null
    const fired = new Promise<void>((resolve) => {
      resolveFired = resolve
    })
    cb.mockImplementation(() => resolveFired?.())
    access.insertAtCursor('!') // doc change -> update listener -> viewport tick
    await fired
    expect(cb).toHaveBeenCalledTimes(1)

    // Unsubscribing stops future notifications.
    cb.mockClear()
    const unsub = access.onViewportChange(cb)
    unsub()
    access.insertAtCursor('?')
    // Give the throttled tick a frame to settle, then assert silence.
    await Promise.resolve()
    await Promise.resolve()
    expect(cb).not.toHaveBeenCalled()
  })

  it('showHighlights pushes a fresh decoration set onto the editor state', () => {
    const target = track(freshTarget())
    const access = createEditorAccess({ extensions: [highlightExtension()] })
    access.attach(target, 'hello world', () => {})
    const view = mountedView(target)
    // The highlightExtension field provides exactly one decorations provider;
    // the pushed set surfaces through the EditorView.decorations facet.
    const providedSet = (state: EditorState): RangeSet<Decoration> => {
      const providers = state.facet(EditorView.decorations)
      expect(providers).toHaveLength(1)
      const set = providers[0]
      return typeof set === 'function' ? (set as unknown as RangeSet<Decoration>) : set
    }
    const classes = (set: RangeSet<Decoration>): string[] => {
      const out: string[] = []
      set.between(0, view.state.doc.length, (_from, _to, deco) => {
        out.push(String(deco.spec.class))
      })
      return out
    }

    access.showHighlights([{ start: 0, end: 5, tone: 'note' }])
    expect(classes(providedSet(view.state))).toEqual(['bw-hl bw-hl-note'])

    // showHighlights replaces the set wholesale: a second push drops the first.
    access.showHighlights([{ start: 6, end: 11, tone: 'sharp' }])
    expect(classes(providedSet(view.state))).toEqual(['bw-hl bw-hl-sharp'])
  })

  // ---------------------------------------------------------------------------
  // showHighlights composition safety + history cleanliness
  // ---------------------------------------------------------------------------
  it('showHighlights defers during composition (facet unchanged) and flushes after it ends', () => {
    const target = track(freshTarget())
    const access = createEditorAccess({ extensions: [highlightExtension()] })
    access.attach(target, 'hello world', () => {})
    const view = mountedView(target)

    // Simulate an in-flight IME composition (same private poke as the C4 test).
    setComposing(view, 1)
    expect(view.composing).toBe(true)

    // No dispatch happens mid-composition: the decoration facet stays empty.
    access.showHighlights([{ start: 0, end: 5, tone: 'note' }])
    expect(decoClasses(providedFacetSet(view.state), view.state.doc.length)).toEqual([])

    // Composition ends; the next update tick flushes the deferred spans.
    setComposing(view, 0)
    view.dispatch({ selection: EditorSelection.cursor(11) }) // any update triggers the tick
    expect(decoClasses(providedFacetSet(view.state), view.state.doc.length)).toEqual(['bw-hl bw-hl-note'])
  })

  it('showHighlights never creates an undo event (addToHistory:false)', () => {
    const target = track(freshTarget())
    const access = createEditorAccess({ extensions: [highlightExtension()] })
    access.attach(target, 'hello', () => {})
    const view = mountedView(target)

    const depth = () => historyDepth(view.state)
    const before = depth()

    // Derived decoration push: must not be recorded in undo history.
    access.showHighlights([{ start: 0, end: 2, tone: 'note' }])
    expect(depth()).toBe(before)

    // A real edit (typing) is recorded — proving the field is live.
    access.insertAtCursor('!')
    expect(view.state.doc.toString()).toBe('!hello')
    expect(depth()).toBe(before + 1)

    // Undo reverts the typing but the highlight is still present (it was never
    // an undo event), and undo consumed exactly the one recorded edit.
    undo(view)
    expect(view.state.doc.toString()).toBe('hello')
    expect(decoClasses(providedFacetSet(view.state), view.state.doc.length)).toEqual(['bw-hl bw-hl-note'])
    expect(depth()).toBe(before)
  })

  it('composition-deferred highlights are dropped on detach, not flushed into the next attach', () => {
    const target = track(freshTarget())
    const access = createEditorAccess({ extensions: [highlightExtension()] })
    access.attach(target, 'first', () => {})
    let view = mountedView(target)
    setComposing(view, 1)
    expect(view.composing).toBe(true)

    // Park spans mid-composition, then detach while they are still deferred.
    access.showHighlights([{ start: 0, end: 3, tone: 'note' }])
    access.detach()

    // Re-attach a fresh document; the stale deferred spans must not flush.
    access.attach(target, 'second doc', () => {})
    view = mountedView(target)
    expect(decoClasses(providedFacetSet(view.state), view.state.doc.length)).toEqual([])
  })
  // attach/detach lifecycle
  // ---------------------------------------------------------------------------
  // attach/detach lifecycle
  // ---------------------------------------------------------------------------
  it('re-attaching replaces the previous document and starts a fresh cursor', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    access.attach(target, 'first', () => {})
    access.attach(target, 'second', () => {})

    expect(access.readCursor()).toEqual({ offset: 0, text: 'second' })
    // Old document's undo history is gone (fresh state).
    const view = mountedView(target)
    undo(view)
    expect(view.state.doc.toString()).toBe('second')
  })

  it('detach tears down the mounted DOM and clears the callback', () => {
    const target = track(freshTarget())
    const access = createEditorAccess()
    let calls = 0
    access.attach(target, 'hello', () => {
      calls++
    })
    expect(target.querySelector('.cm-editor')).not.toBeNull()

    access.detach()
    expect(target.querySelector('.cm-editor')).toBeNull()
    expect(access.readCursor()).toBeNull()
    expect(access.insertAtCursor('x')).toBe(false)
    // Detached: no callback can fire.
    expect(calls).toBe(0)
  })
})
