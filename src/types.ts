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
}
