/**
 * highlight: the question-highlight overlay.
 *
 * Paints a soft background over the draft span a coach question is anchored
 * to (or, when the anchor is missing — static demo — the block under the
 * cursor), plus a small popover near it showing the question.
 *
 * Layout: the classic mirror-div technique. The overlay is an absolutely
 * positioned layer covering the scrollport's visible box (the package's
 * `.w-md-editor-area` — the textarea itself is height:100% of the grown text
 * container and never scrolls). Inside it, a mirror div (reusing the package's
 * own `w-md-editor-text-pre` class so font/padding/line-height/wrapping match
 * the visible text exactly) spans the textarea's full content box and renders
 * the draft with transparent text, the anchor span carrying a translucent
 * background. The textarea below shows its real text through the tint, so the
 * highlight reads like a marker stroke over the prose.
 *
 * Scrolling: we listen for `scroll` on the scrollport and translate the mirror
 * (and the popover) by the negative offsets — content stays glued to the
 * anchored text without re-rendering on scroll.
 *
 * Known limitation: wrap alignment assumes overlay scrollbars (Linux/Chromium
 * target); platforms with reserved scrollbar gutters can misalign wrapping by
 * the gutter width.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

export interface HighlightOverlayProps {
  /** The full draft, as shown in the editor. */
  draft: string
  /** The span the question is about; null in the static demo (see cursorBlock). */
  anchor: { start: number; end: number } | null
  /** The coach question to show in the popover; null hides the overlay. */
  question: string | null
  /** Fallback span (block under the cursor) used when anchor is null. */
  cursorBlock: { start: number; end: number } | null
  /** The editor's textarea, used for measurement and scroll tracking. */
  textareaRef: RefObject<HTMLTextAreaElement>
  /** Called when the Resolved button inside the popover is clicked. */
  onResolve?: () => void
  /**
   * Popover visibility: when true the popover always shows (the original
   * single-question behavior); when false it opens only while this
   * annotation's highlight is clicked. Default true.
   */
  openOnClickOnly?: boolean
  /**
   * Monotonic id of the currently open annotation. Each click-to-open
   * overlay reports its own key via onOpenChange and closes itself when
   * activeId no longer matches — so two popovers can never overlap.
   * Required when openOnClickOnly is true.
   */
  noteId?: string
  activeId?: string | null
  onOpenChange?: (id: string | null) => void
}

interface Layout {
  left: number
  top: number
  width: number
  height: number
  /** The textarea's full content-box size (mirror spans the whole document). */
  mirrorWidth: number
  mirrorHeight: number
  /** The textarea's computed padding (content origin alignment). */
  padding: string
  /** The textarea's computed line-height (wrap-lock with the mirror). */
  lineHeight: string
}

interface PopoverPos {
  left: number
  top: number
}

const POPOVER_GAP = 6
const POPOVER_INSET = 4

export function HighlightOverlay({
  draft,
  anchor,
  question,
  cursorBlock,
  textareaRef,
  onResolve,
  openOnClickOnly = false,
  noteId,
  activeId = null,
  onOpenChange,
}: HighlightOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef({ left: 0, top: 0 })

  const [layout, setLayout] = useState<Layout | null>(null)
  const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null)

  // The span to paint: the anchor when the question grounded, otherwise the
  // cursor block (static demo questions cannot ground).
  const span = anchor ?? cursorBlock
  const active = span !== null && question !== null && question !== ''
  const spanStart = span?.start ?? null
  const spanEnd = span?.end ?? null

  // Click-to-open with a SINGLE-OPEN contract, owned entirely by the
  // parent's activeId: this overlay renders its popover exactly while the
  // parent names it as active. Clicking reports the id; clicking again
  // reports null. No local "open" state exists — a per-overlay flag goes
  // stale when another note claims the slot and resurrects every stale
  // popover once activeId returns to null (measured live: all popovers at
  // once after toggle-close), so visibility derives from activeId alone.
  const popoverVisible = !openOnClickOnly || (activeId !== null && activeId === noteId)
  const toggleThis = () => {
    onOpenChange?.(popoverVisible ? null : noteId ?? null)
  }

  // Geometry + scroll sync. The scrollport is the package's `.w-md-editor-area`
  // wrapper (overflow: auto, where react-md-editor wires its own onScroll) —
  // the textarea itself is height:100% of the grown text container and never
  // scrolls. We position over the scrollport's visible box, size the mirror to
  // the textarea's full content box, and translate by the scrollport offsets.
  // The transform is applied imperatively so scrolling never re-renders React.
  useLayoutEffect(() => {
    if (!active) return
    const textarea = textareaRef.current
    const root = rootRef.current
    if (!textarea || !root) return

    // Fallbacks cover non-package DOM (custom renderTextarea, tests).
    const scroller = textarea.closest('.w-md-editor-area') ?? textarea.parentElement ?? textarea

    const applyScroll = () => {
      const { left, top } = scrollRef.current
      const transform = `translate(${-left}px, ${-top}px)`
      if (mirrorRef.current) mirrorRef.current.style.transform = transform
      if (popoverRef.current) popoverRef.current.style.transform = transform
    }

    const measure = () => {
      const areaRect = scroller.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const cs = getComputedStyle(textarea)
      scrollRef.current = { left: scroller.scrollLeft, top: scroller.scrollTop }
      applyScroll()
      setLayout({
        left: areaRect.left - rootRect.left,
        top: areaRect.top - rootRect.top,
        width: areaRect.width,
        height: areaRect.height,
        mirrorWidth: textarea.offsetWidth,
        mirrorHeight: textarea.offsetHeight,
        padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        // Wrap-lock: the textarea lays out at its own line-height (here
        // 21px) while the overlay would otherwise inherit the app's 1.5.
        // A mismatch drifts every highlight after the first wrapped line.
        lineHeight: cs.lineHeight,
      })
    }
    measure()

    const onScroll = () => {
      scrollRef.current = { left: scroller.scrollLeft, top: scroller.scrollTop }
      applyScroll()
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })

    // Re-measure when the editor resizes (scrollport box) or the document
    // grows (textarea content box).
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(scroller)
    ro?.observe(textarea)

    return () => {
      scroller.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [active, spanStart, spanEnd, textareaRef])

  // Popover placement: below the anchor's first line, clamped to the layer,
  // flipped above when the anchor sits in the bottom part of the editor.
  useLayoutEffect(() => {
    if (!active || !layout) return
    // The mirror/popover are mounted now — apply the initial scroll offset
    // (the geometry effect runs before they exist).
    const { left: sl, top: st } = scrollRef.current
    const transform = `translate(${-sl}px, ${-st}px)`
    if (mirrorRef.current) mirrorRef.current.style.transform = transform
    if (popoverRef.current) popoverRef.current.style.transform = transform

    const highlight = highlightRef.current
    const popover = popoverRef.current
    if (!highlight) return
    const lineHeight = highlight.offsetHeight || 18
    const rawLeft = highlight.offsetLeft
    const rawTop = highlight.offsetTop
    let left = rawLeft
    let top = rawTop + lineHeight + POPOVER_GAP
    if (popover) {
      const pw = popover.offsetWidth
      const ph = popover.offsetHeight
      left = Math.max(POPOVER_INSET, Math.min(rawLeft, layout.width - pw - POPOVER_INSET))
      if (top + ph > layout.height - POPOVER_INSET) {
        top = rawTop - ph - POPOVER_GAP
      }
      top = Math.max(POPOVER_INSET, top)
    }
    setPopoverPos({ left, top })
  }, [active, layout, spanStart, spanEnd, question, popoverVisible])

  if (!active) return null

  const before = draft.slice(0, spanStart!)
  const fragment = draft.slice(spanStart!, spanEnd!)
  const after = draft.slice(spanEnd!)
  // The package's own mirror renders `markdown + "\n"` (the textarea keeps a
  // final caret line); match it so scroll heights line up at the bottom.
  const mirrorText = '\n'

  return (
    <div
      ref={rootRef}
      className="coach-highlight-layer"
      style={{
        position: 'absolute',
        left: layout?.left ?? 0,
        top: layout?.top ?? 0,
        width: layout?.width ?? 0,
        height: layout?.height ?? 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {layout && (
        <div
          ref={mirrorRef}
          className="coach-highlight-mirror w-md-editor-text-pre"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: layout.mirrorWidth,
            height: layout.mirrorHeight,
            padding: layout.padding,
            lineHeight: layout.lineHeight,
            transform: 'translate(0px, 0px)',
          }}
        >
          <code>
            {before}
            <span
              ref={highlightRef}
              className={openOnClickOnly ? 'coach-highlight-span coach-highlight-clickable' : 'coach-highlight-span'}
              // Click-to-open: sweep notes pass openOnClickOnly — the highlight paints always, the popover opens only while clicked.
              onPointerDown={openOnClickOnly ? toggleThis : undefined}
            >
              {fragment}
            </span>
            {after}
            {mirrorText}
          </code>
        </div>
      )}
      {layout && popoverVisible && (
        <div
          ref={popoverRef}
          className="coach-popover"
          style={{
            position: 'absolute',
            left: popoverPos?.left ?? 0,
            top: popoverPos?.top ?? 0,
            transform: 'translate(0px, 0px)',
          }}
        >
          {question}
          {onResolve && (
            <button type="button" className="coach-resolve" onClick={onResolve}>
              Resolved
            </button>
          )}
        </div>
      )}
    </div>
  )
}
