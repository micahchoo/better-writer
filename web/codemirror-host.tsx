/**
 * codemirror-host: the React mount point for the CodeMirror editor.
 *
 * The theme lives here too (plan FA-5): an EditorView.theme copied from the
 * measured `.w-md-editor-text-input` computed styles (font/size/line-height/
 * padding/color/overflow-wrap) so the CM6 surface visually matches the old
 * textarea. Colors reference the same var(--token) names as style.css (:root
 * dark defaults, [data-theme='light'] overrides), so the editor re-styles
 * instantly on a theme swap with no remount and no Compartment machinery —
 * the browser re-resolves the custom property for the live view. It is
 * exported so EditorApp threads it into the seam via the `extensions`
 * passthrough (Task 5 appends highlightExtension() the same way). holds a plain div, attaches the seam's EditorView into it once on mount
 * (with the mount-time initialText and change callback), and detaches on
 * unmount. StrictMode-safe: the mount effect's cleanup detaches, so React's
 * dev double-invoke (attach → detach → attach) tears down cleanly and the
 * seam's re-attach replaces the previous view without leaking it.
 *
 * The component owns NO editor state: every byte enters the buffer through
 * the `editorAccess` it receives (plan C1). All content updates — typing
 * (via onDocChange), dictation insertAtCursor, sample-load replaceDocument,
 * async draft restore — are driven imperatively through that seam, never by
 * re-attaching on a changing value prop. The `initialText`/`onDocChange`
 * deps are intentionally omitted from the effect's array: re-running attach
 * on a per-keystroke-recreated callback would wipe undo history and the
 * caret. Both are captured at mount, which is correct because the app syncs
 * the buffer through editorAccess, not through React props.
 *
 * The theme lives here too (plan FA-5): an EditorView.theme copied from the
 * measured `.w-md-editor-text-input` computed styles (font/size/line-height/
 * padding/color/overflow-wrap) so the CM6 surface visually matches the old
 * textarea. It is exported so EditorApp threads it into the seam via the
 * `extensions` passthrough (Task 5 appends highlightExtension() the same way).
 */

import { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import type { Transaction } from '@codemirror/state'
import type { EditorAccess } from './editor-access'

export interface CodeMirrorHostProps {
  /** The single editor seam, built once in EditorApp via useMemo. */
  editorAccess: EditorAccess
  /** Mount-time document; the buffer is thereafter driven via editorAccess. */
  initialText: string
  /** Fired once per doc-changing transaction batch, after state is committed. */
  onDocChange: (text: string, transactions: readonly Transaction[]) => void
  /**
   * Fired (rAF-throttled) whenever the editor's viewport may have shifted —
   * any view update (selection/doc/geometry), a scroll of the scroller, or a
   * window resize. The host forwards it to the seam's onViewportChange, which
   * owns the update-listener + scroll wiring (C1: the EditorView is never
   * exposed to React). Used to reposition floating popovers.
   */
  onViewportChange: () => void
}

/**
 * Editor theme matching the old prose surface. Values were measured from the
 * pre-migration `.w-md-editor-text-input` computed style (see migration plan
 * Task 3 characterization): JetBrains Mono, 14px, 21px line-height (1.5),
 * 20px padding with a 144px bottom clear for the docked coach panel,
 * `break-word` overflow-wrap, and the app's themed text color inherited from
 * the `.editor-wrapper` (light/dark switch automatically via the app class).
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'var(--font-draft)',
    fontSize: '14px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    fontFamily: 'var(--font-draft)',
    lineHeight: '1.5',
    padding: '20px 20px 144px 20px',
    overflowWrap: 'break-word',
    caretColor: 'currentColor',
    color: 'var(--text)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-draft)',
    overflowY: 'auto',
    overflowX: 'hidden',
  },
})

export default function CodeMirrorHost({ editorAccess, initialText, onDocChange, onViewportChange }: CodeMirrorHostProps) {
  const divRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const div = divRef.current
    if (!div) return
    // attach owns focus() once after mount (autoFocus parity), and fires
    // onDocChange only for real document changes, never on mount.
    editorAccess.attach(div, initialText, onDocChange)
    // Register the viewport-change subscription so popovers reposition on
    // selection/doc updates, scroller scroll, and window resize.
    const unsubViewport = editorAccess.onViewportChange(onViewportChange)
    return () => {
      unsubViewport()
      editorAccess.detach()
    }
    // Mount once: initialText and onDocChange are captured at mount on
    // purpose (see header). Only the stable editorAccess instance is watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorAccess])

  return <div ref={divRef} className="cm6-host" style={{ height: '100%' }} />
}
