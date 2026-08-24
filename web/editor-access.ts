/**
 * editor-access: the single seam between the app and the editor substrate.
 *
 * CM6 migration (Task 2): this seam now mounts a real `@codemirror/view`
 * `EditorView` instead of reaching into an MDEditor textarea. All cursor reads,
 * programmatic insertion, whole-document replacement, scrolling, range geometry
 * and highlight decoration dispatch flow through this one object; no caller
 * ever sees an `EditorView` or imports from `@codemirror/*`. The only modules
 * that touch CodeMirror directly are this seam and `codemirror-host.tsx`.
 *
 * History policy (C3) lives here: `replaceDocument` excludes its full-doc
 * change from undo history by default so prior events are merely mapped across
 * it, and `{ history: 'reset' }` recreates the state entirely (guide-recommended
 * true reset). Composition safety (C4): `insertAtCursor` no-ops mid-composition,
 * and `showHighlights` defers its dispatch while composing, flushing on the next
 * update tick.
 */

import {
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { buildHighlightSet, pushHighlights, type HighlightSpan } from './decorations'

export type { HighlightSpan } from './decorations'

/** A rectangle in viewport coordinates, matching CM6's coordsAtPos shape. */
export interface Rect {
  top: number
  bottom: number
  left: number
  right: number
}

export interface CursorPosition {
  /** Character offset of the caret in the full editor text. */
  offset: number
  /** The full editor text. */
  text: string
}

export interface EditorAccess {
  /** Mount an editor into `target` with `initialText`, focusing it, and notify
   *  `onDocChange` once per transaction batch that changes the document, after
   *  the state is committed. */
  attach(
    target: HTMLElement,
    initialText: string,
    onDocChange: (text: string, transactions: readonly Transaction[]) => void,
  ): void
  /** Tear down the editor and forget the change callback. */
  detach(): void
  /** Caret offset + full text, or null when detached. */
  readCursor(): CursorPosition | null
  /** Replace the current selection with `text`, caret after the insert.
   *  Returns false when detached or composing (C4). */
  insertAtCursor(text: string): boolean
  /** Replace the whole document. Default excludes the change from history (C3);
   *  `{ history: 'reset' }` recreates the state so no prior history survives. */
  replaceDocument(next: string, opts?: { history?: 'exclude' | 'reset' }): void
  /** Scroll `offset` into view. */
  scrollToOffset(offset: number): void
  /** Bounding box of the [from,to) range, or null when detached or empty. */
  rectForRange(from: number, to: number): Rect | null
  /**
   * Register a callback fired (rAF-throttled) whenever the editor's viewport
   * may have shifted: any view update (selection/doc/geometry), a scroll of
   * the scroller, or a window resize. Returns an unsubscribe. Used to keep
   * floating UI (popovers) pinned to ranges without exposing the EditorView.
   */
  onViewportChange(cb: () => void): () => void
  /** Replace the editor's highlight decoration set from reconciled spans
   *  (C2 — derived, rebuilt wholesale; the StateField maps it across doc
   *  changes between pushes). Deferred while composing, flushed on the next
   *  update tick. Never recorded in undo history. No-op when detached.
   *  Offsets are doc coordinates. */
  showHighlights(spans: readonly HighlightSpan[]): void
}

export interface EditorAccessOptions {
  /**
   * Caller extensions appended AFTER the base bundle on every state this
   * seam mounts. Theme (see codemirror-host) and the derived highlight
   * extension are injected here — they must come after the base
   * keymaps/history so their facet contributions take precedence.
   */
  extensions?: Extension[]
}

/** Shared extension bundle for every state this seam mounts. */
const baseExtensions = (): Extension[] => [
  history(),
  EditorView.lineWrapping,
  keymap.of(historyKeymap),
  keymap.of(defaultKeymap),
]

/** Bounding box of two rects: min of top/left, max of bottom/right. */
export function unionRects(a: Rect, b: Rect): Rect {
  return {
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
  }
}

export function createEditorAccess(options: EditorAccessOptions = {}): EditorAccess {
  let view: EditorView | null = null
  let onDocChange: ((text: string, transactions: readonly Transaction[]) => void) | null = null
  // Viewport-change subscribers (rAF-throttled; see onViewportChange). Fired on
  // any view update, scroller scroll, or window resize so floating UI can
  // reposition. The callback list is swapped wholesale (single subscriber in
  // practice — the React host) via a setter that returns an unsubscribe.
  let viewportCbs: Set<() => void> = new Set()
  let rafPending = false
  // Highlights stashed while an IME composition is in flight (C4-style guard):
  // showHighlights must not dispatch mid-composition, so it parks the spans
  // here and the update listener flushes them once composing ends.
  let pendingSpans: readonly HighlightSpan[] | null = null
  // rAF-throttle with a setTimeout fallback for environments without
  // requestAnimationFrame (jsdom test hosts). The tick coalesces bursts of
  // updates (typing, scroll) into one reposition per frame.
  const raf =
    typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 0)
  const notifyViewport = () => {
    if (rafPending) return
    rafPending = true
    raf(() => {
      rafPending = false
      for (const cb of viewportCbs) cb()
    })
  }

  // Push any deferred highlight set once the view is attached, not composing,
  // and spans are waiting. Always excluded from history (never an undo event).
  // Safe to call detached: guards on view.
  const flushPendingHighlights = () => {
    if (!view || view.composing || !pendingSpans) return
    const spans = pendingSpans
    pendingSpans = null
    view.dispatch({
      effects: pushHighlights.of(buildHighlightSet(spans, view.state.doc.length)),
      annotations: [Transaction.addToHistory.of(false)],
    })
  }

  const createState = (doc: string): EditorState =>
    EditorState.create({
      doc,
      extensions: [
        ...baseExtensions(),
        // View update listener: fires on every transaction (selection, doc,
        // geometry) after commit — the "(a) selection/doc updates" trigger.
        // Also the flush point for composition-deferred highlights: the tick
        // that ends composition is an update, so deferred spans land here.
        EditorView.updateListener.of(() => {
          notifyViewport()
          flushPendingHighlights()
        }),
        ...(options.extensions ?? []),
      ],
    })

  const onScroll = () => notifyViewport()

  return {
    attach(target, initialText, cb) {
      // A re-attach must not leak a live view into the new one.
      if (view) {
        view.destroy()
        view = null
      }
      onDocChange = cb
      const state = createState(initialText)
      view = new EditorView({
        state,
        parent: target,
        // Default dispatch plus a doc-change notification after the state is
        // committed, so callbacks always observe fresh state.
        dispatch: (tr) => {
          view!.update([tr])
          if (tr.docChanged && onDocChange) {
            onDocChange(view!.state.doc.toString(), [tr])
          }
        },
      })
      // "(b) scroll of .cm-scroller": the scroller is CM6's scrollDOM.
      view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })
      view.focus()
    },

    detach() {
      if (view) {
        view.scrollDOM.removeEventListener('scroll', onScroll)
        view.destroy()
        view = null
      }
      onDocChange = null
      viewportCbs = new Set()
      // Forget any deferred spans: a re-attach must not flush stale marks into
      // the fresh view.
      pendingSpans = null
    },

    readCursor() {
      if (!view) return null
      return {
        offset: view.state.selection.main.head,
        text: view.state.doc.toString(),
      }
    },

    insertAtCursor(text) {
      if (!view || view.composing) return false
      const sel = view.state.selection.main
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: EditorSelection.cursor(sel.from + text.length),
      })
      return true
    },

    replaceDocument(next, opts) {
      if (!view) return
      if (opts?.history === 'reset') {
        // True reset (guide-recommended): recreate the state so no undo history
        // or selection survives from the previous document.
        view.setState(createState(next))
        return
      }
      // Default C3 path: full-doc change excluded from history; prior events are
      // mapped across it, so undo never resurrects the pre-replace text wholesale.
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        selection: EditorSelection.cursor(0),
        annotations: [Transaction.addToHistory.of(false)],
      })
    },

    scrollToOffset(offset) {
      if (!view) return
      view.dispatch({ effects: EditorView.scrollIntoView(offset) })
    },

    rectForRange(from, to) {
      if (!view || from >= to) return null
      const a = view.coordsAtPos(from)
      const b = view.coordsAtPos(to)
      if (!a || !b) return null
      return unionRects(a, b)
    },

    onViewportChange(cb) {
      viewportCbs.add(cb)
      return () => viewportCbs.delete(cb)
    },

    showHighlights(spans) {
      if (!view) return
      // Never dispatch during an IME composition — CM6's update pipeline
      // mis-sequences effects mid-composition. Park the spans; the update
      // listener flushes them once composing ends.
      if (view.composing) {
        pendingSpans = spans
        return
      }
      view.dispatch({
        effects: pushHighlights.of(buildHighlightSet(spans, view.state.doc.length)),
        // A highlight push is derived decoration, not user text: it must never
        // create an undo event or displace the user's undo history.
        annotations: [Transaction.addToHistory.of(false)],
      })
    },
  }
}
