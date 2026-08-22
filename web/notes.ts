/**
 * notes: note identity and construction for pinned coach annotations.
 *
 * A pinned note is a persisted Annotation (see src/types.ts / draft-store's
 * Note alias) — an anchor span plus the question it was grounded on. This
 * module owns the two facts every caller needs and must agree on:
 *
 *   1. HOW a note is minted from a fresh anchor + question (makeNote), and
 *   2. WHAT makes one note the same as another (noteId / sameNote).
 *
 * Identity is deliberately the triple (start, end, ts), not content: two
 * notes anchored to the same span at different moments are DIFFERENT notes
 * (the writer may have asked twice about the same sentence), while re-saving
 * a note unchanged must not change its id. The ts field is the discriminator
 * that keeps HighlightOverlay keys stable across a re-render yet distinct
 * across re-asks.
 *
 * Previously every call site rebuilt this triple inline (some as `${start}:${end}:${ts}`,
 * some field-by-field), so a change to the id scheme or the minting rules had
 * to chase each construction site. Centralizing it here keeps one source of
 * truth for the wire contract's note shape and the overlay-key format.
 */

import type { Annotation as Note } from '../src/types.js';

/** The minimal anchor a note is minted from: the span plus the draft text it covered. */
export interface AnchorSpan {
  start: number;
  end: number;
  fragment: string;
}

/**
 * Mint a note from an anchor + question.
 *
 * Fields are taken verbatim from the anchor — no clamping, no fragment
 * re-derivation (assert-free by design: a caller that already validated the
 * span against the draft shouldn't pay a second slice, and a mismatch here is
 * the caller's invariant to enforce, not a silent correction). The timestamp
 * defaults to now; pass an explicit ts to pin a note to a past event (e.g.
 * replaying a persisted batch) or to make construction deterministic in tests.
 */
export function makeNote(anchor: AnchorSpan, question: string, ts: number = Date.now()): Note {
  return {
    start: anchor.start,
    end: anchor.end,
    fragment: anchor.fragment,
    question,
    ts,
  };
}

/** The identity triple — the subset of a note that says "this is that note". */
export interface NoteIdentity {
  start: number;
  end: number;
  ts: number;
}

/**
 * A stable, collision-free id for a note, formatted as the colon-joined
 * identity triple. The format is a persisted contract: HighlightOverlay keys
 * and open/active popover ids are built from it, so changing the separator or
 * omitting a field would silently orphan open popovers across a reload. Any
 * note type exposing start/end/ts can be addressed by it.
 */
export function noteId(note: NoteIdentity): string {
  return `${note.start}:${note.end}:${note.ts}`;
}

/**
 * Whether two note identities refer to the same note — i.e. the same span
 * minted at the same moment. Equivalent to comparing noteId(), but direct and
 * allocation-free, so identity checks in hot paths (staleness sweeps, popover
 * activation) don't build strings just to compare them.
 */
export function sameNote(a: NoteIdentity, b: NoteIdentity): boolean {
  return a.start === b.start && a.end === b.end && a.ts === b.ts;
}
