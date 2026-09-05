/** Annotation recovery on reload and exact mapping for live edits. */
import type { Annotation } from '../src/core/types';
export type AnchorRecordLike = Pick<Annotation, 'start' | 'end' | 'fragment'> & {
  context?: { before: string; after: string };
};

/** Non-overlapping changes in coordinates of the document before this edit. */
export interface TextChange { from: number; to: number; insert: string }

/** Infer a single changed span when the editor cannot supply exact changes. */
export function textChanges(before: string, after: string): TextChange[] {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  if (from === before.length && from === after.length) return [];
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--; endAfter--;
  }
  return [{ from, to: endBefore, insert: after.slice(from, endAfter) }];
}

/** Drop touched evidence; never reattach a live note to another duplicate. */
export function mapAnnotation<T extends AnchorRecordLike>(note: T, changes: TextChange[]): T | null {
  let shift = 0;
  for (const change of changes) {
    if (change.from === change.to) {
      if (change.from > note.start && change.from < note.end) return null;
    } else if (change.from < note.end && change.to > note.start) return null;
    if (change.to <= note.start) shift += change.insert.length - (change.to - change.from);
  }
  return shift ? { ...note, start: note.start + shift, end: note.end + shift } : note;
}

export function mapAnnotations<T extends AnchorRecordLike>(notes: T[], changes: TextChange[]): T[] {
  return notes.flatMap(note => { const mapped = mapAnnotation(note, changes); return mapped ? [mapped] : []; });
}

export function reconcileAnnotations<T extends AnchorRecordLike>(
  current: T[],
  draft: string,
): { valid: T[]; changed: boolean } {
  const valid = staleAnnotations(current, draft) as T[];
  return {
    valid,
    changed:
      valid.length !== current.length || valid.some((a, i) => a !== current[i]),
  };
}

/**
 * Validate annotations against the draft, re-anchoring instead of dropping
 * where possible. An annotation survives when either:
 * - its fragment still sits exactly at its recorded offsets, or
 * - its fragment appears elsewhere intact (an upstream edit shifted the
 *   offsets without touching the anchored text) — the annotation is remapped
 *   to the occurrence NEAREST its old position.
 *
 * An annotation is dropped only when its fragment no longer exists in the
 * draft, is empty, or has two occurrences equidistant from the old position
 * (remapping would guess).
 *
 * @param annotations persisted annotations to check
 * @param draft the current draft markdown
 * @returns the surviving annotations (moved ones on fresh offset objects),
 *   in input order
 */
/** Length of the longest common suffix of two strings. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the longest common prefix of two strings. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export function staleAnnotations(annotations: AnchorRecordLike[], draft: string): AnchorRecordLike[] {
  return annotations.flatMap((annotation) => {
    // Drop degenerate spans up front: an empty fragment or a zero-length span
    // is invisible (buildHighlightSet requires start < end) yet would
    // otherwise survive the exact-offset check below and ride every save.
    if (!annotation.fragment || annotation.start >= annotation.end) return [];
    if (
      annotation.start >= 0 &&
      annotation.end <= draft.length &&
      draft.slice(annotation.start, annotation.end) === annotation.fragment
    ) {
      return [annotation];
    }
    const occurrences: number[] = [];
    for (
      let idx = draft.indexOf(annotation.fragment);
      idx !== -1;
      idx = draft.indexOf(annotation.fragment, idx + 1)
    ) {
      occurrences.push(idx);
    }
    if (occurrences.length === 0) return [];

    // More than one occurrence: distance from the STALE ABSOLUTE start is the
    // wrong discriminator. A pure insertion before both shifts every
    // occurrence equally, so the earlier duplicate becomes "nearest" and the
    // writer's pinned highlight jumps to a different identical sentence
    // (H9-1). Context — the text that was AROUND this span when the note was
    // minted — survives that shift, so it decides when it is available.
    if (occurrences.length > 1 && annotation.context) {
      const { before, after } = annotation.context;
      let ctxBest = -1;
      let ctxScore = -1;
      let ctxTied = false;
      for (const idx of occurrences) {
        const seenBefore = draft.slice(Math.max(0, idx - before.length), idx);
        const seenAfter = draft.slice(idx + annotation.fragment.length).slice(0, after.length);
        const score = commonSuffix(before, seenBefore) + commonPrefix(after, seenAfter);
        if (score > ctxScore) {
          ctxScore = score;
          ctxBest = idx;
          ctxTied = false;
        } else if (score === ctxScore) {
          ctxTied = true;
        }
      }
      // A tie means the context cannot tell them apart either (identical
      // neighbourhoods); fall through to distance rather than guess.
      if (ctxBest !== -1 && !ctxTied && ctxScore > 0) {
        return [
          {
            ...annotation,
            start: ctxBest,
            end: ctxBest + annotation.fragment.length,
          },
        ];
      }
    }

    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    let tied = false;
    for (const idx of occurrences) {
      const dist = Math.abs(idx - annotation.start);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
        tied = false;
      } else if (dist === bestDist) {
        tied = true;
      }
    }
    if (best === -1 || tied) return [];
    return [{ ...annotation, start: best, end: best + annotation.fragment.length }];
  });
}
