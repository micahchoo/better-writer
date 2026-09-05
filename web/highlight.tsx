/**
 * highlight: the coach-question popover.
 *
 * Task 5 — the mirror-div geometry machine is gone. Highlights paint natively
 * as CodeMirror mark decorations (see decorations.ts), so this module is
 * reduced to the one thing the editor cannot paint: the small popover that
 * shows a question near its anchored span.
 *
 * Positioning: the popover reads the anchor's bounding box from the seam via
 * `rectForRange(anchor.start, anchor.end)` (a CM6 coordsAtPos union, in
 * viewport coordinates). The seam's `onViewportChange` (wired by the host)
 * bumps a monotonically increasing `viewportTick` on selection/doc updates,
 * scroller scroll, and window resize; this component re-runs its placement
 * effect on that tick so the popover stays glued to the anchored text.
 *
 * Click-open: sweep notes pass `openOnClickOnly` — the popover opens only
 * while the parent names this note as active (the SINGLE-OPEN contract, owned
 * entirely by the parent's activeId, unchanged from the mirror era). The
 * actual span click is delegated by EditorApp from the host wrapper div via
 * the marks' data-start/data-end attributes; this component never handles
 * clicks.
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { QuestionSource } from '../src/core/types'
import type { AnchorRecord } from './draft-store'

export interface HighlightOverlayProps {
  /** The span the question is about; null hides the overlay. */
  anchor: { start: number; end: number } | null
  /** The coach question to show in the popover; null hides the overlay. */
  question: string | null
  /** How the question was produced (see src/types QuestionSource); a
   * 'topic-probe' shows a small "generic" chip so the writer sees the model
   * fell back to a fixed probe. Optional. */
  source?: QuestionSource
  /** Bounding box getter for a doc range (viewport coords), from the seam. */
  rectForRange: (from: number, to: number) => { top: number; bottom: number; left: number; right: number } | null
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
  /**
   * Monotonically increasing viewport tick, bumped by the seam's
   * onViewportChange (host wiring). Re-running placement on this keeps the
   * popover pinned to the anchor across selection/doc updates, scroll, and
   * resize.
   */
  viewportTick: number
}

interface PopoverPos {
  left: number
  top: number
}

const POPOVER_GAP = 6
const POPOVER_INSET = 4

/** A rectangle in viewport or root-relative coordinates. */
export interface BoxRect {
  top: number
  bottom: number
  left: number
  right: number
}

/**
 * Map a clicked highlight mark back to the note it decorates (click-open
 * parity). The mark carries data-start/data-end (doc offsets, see
 * decorations.ts buildHighlightSet); the note whose span matches is returned,
 * or null when the click was not on a note's mark. Pure aside from reading
 * the element's attributes — unit-tested with a stubbed element.
 */
export function noteFromMark(mark: Element | null, notes: AnchorRecord[]): AnchorRecord | null {
  if (!mark) return null
  const start = Number(mark.getAttribute('data-start'))
  const end = Number(mark.getAttribute('data-end'))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return notes.find((n) => n.start === start && n.end === end) ?? null
}

/**
 * Pure popover placement math (unit-tested without a DOM layout engine).
 *
 * Places the popover below the anchor's bottom edge, clamped horizontally to
 * the container; when it would overflow the container's bottom it flips above
 * the anchor's top edge instead. All coordinates are in the same (root-
 * relative) space; the caller translates viewport coords before calling.
 */
export function computePopoverPosition(
  anchor: BoxRect,
  container: { width: number; height: number },
  popover: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(POPOVER_INSET, Math.min(anchor.left, container.width - popover.width - POPOVER_INSET))
  const below = anchor.bottom + POPOVER_GAP
  const top =
    below + popover.height > container.height - POPOVER_INSET
      ? Math.max(POPOVER_INSET, anchor.top - popover.height - POPOVER_GAP)
      : Math.max(POPOVER_INSET, below)
  return { left, top }
}

export function HighlightOverlay({
  anchor,
  question,
  source,
  rectForRange,
  onResolve,
  openOnClickOnly = false,
  noteId,
  activeId = null,
  viewportTick,
}: HighlightOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverPos, setPopoverPos] = useState<PopoverPos | null>(null)

  const active = anchor !== null && question !== null && question !== ''
  const spanStart = anchor?.start ?? null
  const spanEnd = anchor?.end ?? null

  // SINGLE-OPEN contract: visibility derives from activeId alone (see the
  // mirror-era comment — a stale per-overlay flag resurrects every popover
  // once the slot returns to null, measured live).
  const popoverVisible = !openOnClickOnly || (activeId !== null && activeId === noteId)

  // Placement: below the anchor's first line, clamped to the editor box,
  // flipped above when the anchor sits in the bottom part of the editor.
  // Re-runs on every viewport tick so the popover follows its text.
  useLayoutEffect(() => {
    if (!active || !popoverVisible || anchor === null) return
    const rect = rectForRange(anchor.start, anchor.end)
    const root = rootRef.current
    const popover = popoverRef.current
    if (!rect || !root || !popover) return

    const rootRect = root.getBoundingClientRect()
    // Translate the viewport-relative anchor rect into the root's box, then
    // defer the placement math to the pure helper (unit-tested directly).
    const anchorInRoot: BoxRect = {
      top: rect.top - rootRect.top,
      bottom: rect.bottom - rootRect.top,
      left: rect.left - rootRect.left,
      right: rect.right - rootRect.left,
    }
    setPopoverPos(
      computePopoverPosition(
        anchorInRoot,
        { width: rootRect.width, height: rootRect.height },
        { width: popover.offsetWidth, height: popover.offsetHeight },
      ),
    )
  }, [active, popoverVisible, spanStart, spanEnd, question, viewportTick, rectForRange])

  if (!active || !popoverVisible) return null

  return (
    <div
      ref={rootRef}
      className="coach-popover-layer"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}
    >
      <div
        ref={popoverRef}
        className="coach-popover"
        style={{
          position: 'absolute',
          left: popoverPos?.left ?? 0,
          top: popoverPos?.top ?? 0,
        }}
      >
        {/* Honest provenance: a topic-probe question came from a fixed
            probe, not the live text — label it so the writer reads it as
            generic rather than grounded in their words. */}
        {source === 'topic-probe' && <span className="source-chip">generic</span>}
        {question}
        {onResolve && (
          <button type="button" className="coach-resolve" onClick={onResolve}>
            Resolved
          </button>
        )}
      </div>
    </div>
  )
}
