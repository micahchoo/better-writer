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
  opts?: { temperature?: number },
) => Promise<string>;

/**
 * How a question's text was produced — surfaced to the writer as honesty
 * about the model's part: a seed verbatim, a model reshaped it against the
 * live text, or it fell back to a fixed topic probe. 'seed' is not currently
 * produced by reshape (only the seed bank and static demo emit it) but exists
 * so the UI can label every provenance honestly.
 */
export type QuestionSource = 'seed' | 'reshaped' | 'topic-probe';

/** POST /ask — the client asks the server to reshape one question. */
export interface AskRequest {
  text_window: string;
  /** Character offset of the cursor in the draft; used client-side for anchor adjacency. The server ignores it. */
  cursor_offset: number;
  genre: Genre;
}

export interface AskResponse {
  question: string;
}

/** One pinned craft-question note: the anchor span plus the question, persisted alongside the draft. */
export interface Annotation {
  start: number;
  end: number;
  fragment: string;
  question: string;
  ts: number;
  /** How the question was produced; absent on legacy persisted notes (pre-provenance). */
  source?: QuestionSource;
}
