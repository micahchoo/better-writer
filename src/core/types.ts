/** Shared domain types and the client/server wire contract. */

export type Genre =
  | 'fiction'
  | 'creative-nonfiction'
  | 'memoir'
  | 'essay'
  | 'poetry'
  | 'genre-agnostic';

export const GENRES: readonly Genre[] = [
  'fiction',
  'creative-nonfiction',
  'memoir',
  'essay',
  'poetry',
  'genre-agnostic',
];

export type Verb =
  | 'rewrite'
  | 'elaborate'
  | 'elucidate'
  | 'cut'
  | 'transition'
  | 'concept-form'
  | 'rephrase';

/** A full seed, as `seeds/retrieve.py` emits it. Server side only. */
export interface Seed {
  id: string;
  question: string;
  verb: Verb;
  genre: Genre[];
  source: { book: string; author: string; chapter: string; quote: string };
}

/** A seed-bundle entry shipped to the client. Provenance stripped. */
export interface ClientSeed {
  id: string;
  question: string;
  genre: Genre[];
  verb?: Verb;
}

/** A single conversation turn passed to the local model. */
export interface Turn {
  role: 'user' | 'agent';
  text: string;
}

/** A model completion: (system, turns) -> text. */
export type Complete = (
  system: string,
  turns: Turn[],
  opts?: { temperature?: number; signal?: AbortSignal },
) => Promise<string>;

/**
 * How a question's text was produced — surfaced to the writer as honesty
 * about the model's part: a seed verbatim, a model reshaped it against the
 * live text, or it fell back to a fixed topic probe. 'seed' is not currently
 * produced by reshape (only the seed bank and static demo emit it) but exists
 * so the UI can label every provenance honestly.
 */
export type QuestionSource = 'seed' | 'reshaped' | 'topic-probe';

/** A contiguous window, with focus offsets relative to its text. */
export interface CoachInput {
  textWindow: string;
  genre: Genre;
  cursorOffset: number;
  focus?: { start: number; end: number };
  position?: { sectionBlockCount: number; blockIndexInSection: number };
}

/** Evidence offsets are computed by code, relative to the input window. */
export type CoachResult =
  | { kind: 'question'; question: string; source: QuestionSource;
      evidence?: { quote: string; start: number; end: number } }
  | { kind: 'skip'; reason: 'no-fit' | 'invalid-output' }
  | { kind: 'unavailable'; retryable: boolean };

export interface Coach {
  ask(input: CoachInput, signal?: AbortSignal): Promise<CoachResult>;
}

/** One pinned craft-question note: the anchor span plus the question, persisted alongside the draft. */
export interface Annotation {
  /** Persistent identity; optional only for legacy stored annotations. */
  id?: string;
  start: number;
  end: number;
  fragment: string;
  question: string;
  ts: number;
  /** How the question was produced; absent on legacy persisted notes (pre-provenance). */
  source?: QuestionSource;
  /**
   * The draft text immediately around the span when the note was minted.
   *
   * Used only to re-ground the note when its fragment occurs MORE THAN ONCE
   * and the offsets have drifted: distance from the stale absolute start picks
   * the wrong duplicate after any insertion before both occurrences, so the
   * pinned highlight jumped to a different identical sentence (H9-1). Optional
   * — notes persisted before this field still load and fall back to distance.
   */
  context?: { before: string; after: string };
}
