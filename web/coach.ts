/**
 * coach: the Coach seam — one interface, two adapters.
 *
 *   StaticCoach — uniform-random pick from the bundled seed bank
 *                 (seeds/client.json, shipped as ClientSeed[] with all
 *                 provenance stripped). No model, no network.
 *   LocalCoach  — POST /ask to the local server, which reshapes one question
 *                 with the local model.
 *
 * Only the seed's `question` field ever reaches the writer: `verb`, `source`,
 * and `id` never leave this module.
 *
 * Mode detection: probe GET /health with a short timeout. A 200 JSON response
 * means the local server is up (LocalCoach); anything else — 404, HTML,
 * network error, timeout — falls back to the static demo. GitHub Pages serves
 * no /health, so the deployed build is automatically static.
 */

import type { AskRequest, AskResponse, ClientSeed, Genre, QuestionSource } from '../src/types';
import clientJson from '../seeds/client.json';

const GENRE_AGNOSTIC: Genre = 'genre-agnostic';

export type CoachMode = 'static' | 'local';

export interface Coach {
  /** Ask for one craft question. `cursorOffset` is the caret offset in the
   * full draft; the local server receives it as `cursor_offset` (the client
   * uses it for anchor adjacency). The static coach ignores it. */
  ask(textWindow: string, genre: Genre, cursorOffset: number): Promise<string>;
  /** How the most recently resolved ask produced its question, or null
   * before any ask (and always for StaticCoach, whose pick is a bare seed
   * question with no provenance of its own). Lets a sweep label each note
   * honestly without threading the source through every ask's return. */
  lastSource(): QuestionSource | null;
}

/**
 * A seed matches a genre filter when it carries that genre OR carries the
 * genre-agnostic wildcard, which matches any filter.
 */
export function seedMatchesGenre(seed: ClientSeed, genre: Genre): boolean {
  return seed.genre.includes(GENRE_AGNOSTIC) || seed.genre.includes(genre);
}

/** The pre-generated bundle, cast to the typed shape. */
const bundledSeeds = clientJson as ClientSeed[];

export class StaticCoach implements Coach {
  private readonly seeds: ClientSeed[];

  constructor(seeds: ClientSeed[] = bundledSeeds) {
    this.seeds = seeds;
  }

  async ask(_textWindow: string, genre: Genre, _cursorOffset: number): Promise<string> {
    const pool = this.seeds.filter((seed) => seedMatchesGenre(seed, genre));
    if (pool.length === 0) {
      throw new Error(`No seeds available for genre "${genre}".`);
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return pick.question;
  }

  lastSource(): QuestionSource | null {
    return null;
  }
}

export class LocalCoach implements Coach {
  /** Relative endpoint: the client and server share an origin. */
  private readonly endpoint: string;

  /** Provenance of the last resolved /ask; null until one resolves. */
  private last: QuestionSource | null = null;

  constructor(endpoint = '') {
    this.endpoint = endpoint;
  }

  async ask(textWindow: string, genre: Genre, cursorOffset: number): Promise<string> {
    const body: AskRequest = { text_window: textWindow, genre, cursor_offset: cursorOffset };
    const res = await fetch(`${this.endpoint}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Coach server /ask failed: ${res.status} ${res.statusText}`);
    }
    // /ask returns {question, source}; the extra field stays off the public
    // AskResponse type (the single-annotation flow ignores it) but a sweep
    // reads it back here to label each note's provenance.
    const data = (await res.json()) as AskResponse & { source?: QuestionSource };
    this.last = data.source ?? null;
    return data.question;
  }

  lastSource(): QuestionSource | null {
    return this.last;
  }
}

export function makeCoach(mode: CoachMode): Coach {
  return mode === 'local' ? new LocalCoach() : new StaticCoach();
}

/**
 * Probe the local server. Resolves 'local' only for a 200 response with a
 * JSON content type (a real Hono server); everything else — 404, an SPA
 * fallback page, a timeout, or a network error — resolves 'static'.
 */
export async function detectServerMode(timeoutMs = 1000): Promise<CoachMode> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch('/health', { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    return res.ok && isJson ? 'local' : 'static';
  } catch {
    return 'static';
  }
}
