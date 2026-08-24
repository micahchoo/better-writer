/**
 * decorations: derive CodeMirror highlight decorations from reconciled spans.
 *
 * Annotations are the single source of truth; this module turns a plain list
 * of { start, end, tone } offsets into a CM6 DecorationSet each time they
 * change (plan C2). Positional bookkeeping lives HERE: the StateField maps the
 * held set across doc-changing transactions so marks track text between
 * authoritative pushes. Semantic rebuild stays caller-side — a fresh set is
 * pushed after every reconcile, and pushHighlights replaces wholesale.
 *
 * Tradeoff: marks carry data-start/data-end attrs for click targeting, but
 * mapping repositions the mark range without rewriting those attrs, so they
 * drift from the true doc offsets between authoritative pushes. Acceptable by
 * design — the attrs are visual glue for the popover, not bookkeeping.
 *
 * Public surface:
 *   buildHighlightSet(spans, docLength) -> RangeSet<Decoration>
 *       Pure builder. Clamps defensively (offsets are assumed remapped by
 *       reconcileAnnotations, but a stray value must not crash the editor).
 *   highlightExtension() -> Extension
 *       Installs a private StateField that serves the last pushed set via the
 *       EditorView.decorations facet, mapping it across doc changes, plus the
 *       exported pushHighlights effect for callers to dispatch fresh sets.
 */
import { RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** A single highlight span, offsets in doc coordinates. */
export interface HighlightSpan {
  start: number
  end: number
  /** Coach tone, emitted as `bw-hl-${tone}` in the mark class. */
  tone: string
}

/** Dispatch to replace the current highlight set (replaces, never merges). */
export const pushHighlights = StateEffect.define<DecorationSet>()

/** Private field: holds the latest pushed set and mirrors it to the facet. */
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(pushHighlights)) return effect.value
    }
    // No push: map the held set across doc changes so marks track text between
    // authoritative pushes. Effects-only transactions leave it untouched.
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** Install the highlight state field; served via the EditorView.decorations facet. */
export function highlightExtension(): Extension {
  return highlightField
}

/**
 * Build a sorted DecorationSet from spans.
 *
 * Each span becomes a `Decoration.mark` with class `bw-hl bw-hl-<tone>` and
 * `data-start`/`data-end` attributes (for click targeting by the popover).
 * Offsets are clamped to [0, docLength]; spans that collapse to empty after
 * clamping are dropped. Output is sorted by start for a stable RangeSet.
 */
export function buildHighlightSet(spans: readonly HighlightSpan[], docLength: number): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const length = Math.max(0, docLength)

  for (const span of spans) {
    // Non-finite offsets (NaN/undefined from a malformed store) poison the
    // Math.max/min clamp — NaN survives every comparison, passes the start<end
    // guard, and reaches RangeSet.of where it throws inside React's commit
    // phase. Drop them outright.
    if (!Number.isFinite(span.start) || !Number.isFinite(span.end)) continue
    const start = Math.max(0, Math.min(span.start, length))
    const end = Math.max(0, Math.min(span.end, length))
    if (start >= end) continue

    decorations.push(
      Decoration.mark({
        class: `bw-hl bw-hl-${span.tone}`,
        attributes: {
          'data-start': String(start),
          'data-end': String(end),
        },
      }).range(start, end),
    )
  }

  // RangeSet.of requires ranges sorted by start (and non-overlapping); sort
  // defensively since callers may hand us spans in any order.
  decorations.sort((a, b) => a.from - b.from || a.to - b.to)

  return RangeSet.of(decorations)
}
