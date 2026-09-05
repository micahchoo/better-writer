import type { Annotation as Note } from '../src/core/types.js';

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
/** Characters of surrounding draft stored with a note to disambiguate it. */
export const CONTEXT_CHARS = 32;

export function makeNote(
  anchor: AnchorSpan,
  question: string,
  ts: number = Date.now(),
  draft?: string,
): Note {
  const note: Note = {
    id: crypto.randomUUID(),
    start: anchor.start,
    end: anchor.end,
    fragment: anchor.fragment,
    question,
    ts,
  };
  // Capture the surrounding text when the caller has the draft, so a fragment
  // that occurs more than once can be re-grounded by what is AROUND it rather
  // than by distance from a stale offset (H9-1).
  if (draft !== undefined) {
    note.context = {
      before: draft.slice(Math.max(0, anchor.start - CONTEXT_CHARS), anchor.start),
      after: draft.slice(anchor.end, anchor.end + CONTEXT_CHARS),
    };
  }
  return note;
}

/** Persistent identity, with offsets retained for legacy callers. */
export interface NoteIdentity {
  id?: string;
  start: number;
  end: number;
  ts: number;
}

/** Prefer persisted identity; legacy callers retain the historical fallback. */
export function noteId(note: NoteIdentity): string {
  return note.id ?? `${note.start}:${note.end}:${note.ts}`;
}

/** Identity survives offset changes. */
export function sameNote(a: NoteIdentity, b: NoteIdentity): boolean {
  return noteId(a) === noteId(b);
}

/** Assign deterministic identities before moving legacy anchors. */
export function migrateNotes(notes: Note[]): Note[] {
  const counts = new Map<string, number>();
  return notes.map(note => {
    if (note.id) return note;
    const key = JSON.stringify([note.start, note.end, note.ts, note.fragment, note.question]);
    const occurrence = counts.get(key) ?? 0;
    counts.set(key, occurrence + 1);
    return { ...note, id: `legacy:${key}:${occurrence}` };
  });
}
