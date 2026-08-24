/**
 * coach: the Coach seam — one interface, three adapters.
 *
 *   StaticCoach — uniform-random pick from the seed bank
 *                 (seeds/client.json, shipped as ClientSeed[] with all
 *                 provenance stripped). The bank is loaded lazily on first
 *                 draw so it never inflates the main chunk. No model, no
 *                 network beyond that one module fetch.
 *   LocalCoach  — POST /ask to the local server, which reshapes one question
 *                 with the local model.
 *   ByokCoach  — bring-your-own-key: reshapes in the browser against an
 *                 OpenAI-compatible provider (web/byok.ts). Not constructed
 *                 here; EditorApp builds it directly.
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

const GENRE_AGNOSTIC: Genre = 'genre-agnostic';

export type CoachMode = 'static' | 'local' | 'byok';

/**
 * Whether a mode needs a model at ask time. `'detecting'` is the pre-probe
 * state (the app has not yet decided between static and local); it is not a
 * model-backed mode. Static mode needs no model; local and byok both do.
 */
export function isModelBacked(mode: CoachMode | 'detecting'): boolean {
  return mode === 'local' || mode === 'byok';
}

/**
 * Whether the cadence timer may fire an ask nobody clicked for.
 *
 * The rule is cost, not capability (ADR 0007): a background timer must never
 * spend the writer's money. Static draws a bundled seed and local calls the
 * writer's own server — both are free, so both may fire. BYOK bills the
 * writer per call, so it never may; in that mode the writer asks by clicking
 * Sweep draft. `'detecting'` has no coach yet and must not fire either.
 *
 * Static MUST stay allowed: it has no Sweep control, so the cadence timer is
 * its only path to a question and the hosted demo goes inert without it.
 */
export function mayAutoAsk(mode: CoachMode | 'detecting'): boolean {
  return mode === 'static' || mode === 'local';
}

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

/**
 * Lazily-loaded seed bank. seeds/client.json (~563KB) would inline into the
 * main chunk under a static import; instead it ships as its own
 * dynamic-import chunk, fetched only when a coach first draws a seed. The
 * loaded module is cached, so a draw triggers at most ONE async load, and a
 * second coach (ByokCoach) reuses the same cached module through this shared
 * loader. Tests may inject explicit seeds to bypass the bank entirely.
 */
let seedsPromise: Promise<ClientSeed[]> | null = null
export function loadSeeds(): Promise<ClientSeed[]> {
  seedsPromise ??= import('../seeds/client.json').then(
    (m) => ((m.default ?? m) as unknown) as ClientSeed[],
  )
  return seedsPromise
}

/**
 * The random surface the seed drawer needs: uniform [0,1) draws plus a
 * uniform pick from a sequence — the same surface seeds/retrieve.py's `pull`
 * expects of its `rng` argument, so a seeded MT19937 can reproduce server
 * draws exactly (see coach-pickseed tests). Production uses the
 * Math.random-backed default.
 */
export interface RngLike {
  random(): number;
  choice<T>(seq: T[]): T;
}

/** The default rng: plain Math.random — the pre-parity uniform drawer. */
const MATH_RNG: RngLike = {
  random: () => Math.random(),
  choice: (seq) => seq[Math.floor(Math.random() * seq.length)],
};

/**
 * Soft preference for pickSeed: prefer seeds whose verb is in `verbs`, with a
 * two-stage draw at probability `p` (default 0.5). Mirrors the preference
 * dict of seeds/retrieve.py's pull().
 */
export interface SeedPreference {
  verbs?: string[];
  p?: number;
}

/**
 * Matched-pile size at which the soft-preference probability stops shrinking
 * (FLOOR in seeds/retrieve.py).
 */
const PULL_FLOOR = 16;

/**
 * With an explicit `preference` (verbs set) it reproduces retrieve.py's
 * pull(): a two-stage draw that with probability effective_p
 * (min(p ?? 0.5, matched/16)) picks uniformly from the matched pile, else
 * uniformly from its complement. The verbs-preference OVERRIDES the default
 * genre stratification (folded OUT to avoid double-narrowing), mirroring the
 * CLI where --lean-verbs wins over --genre's default.
 *
 * With no explicit preference, an internal default genre preference engages
 * when the genre filter produced a genuinely mixed pool — at least one card
 * strictly carries `genre` AND at least one matches only via the
 * genre-agnostic wildcard. Then specific-genre cards claim first claim on half
 * the draws (p 0.5, PULL_FLOOR shrink), matching retrieve.py's
 * default_genre_preference. A single-group pool (all specific, or all
 * agnostic-only) or a bare full-bank pull keeps the legacy uniform draw.
 * `rng` is injectable for reproducible draws; it defaults to Math.random.
 */
export function pickSeed(
  seeds: ClientSeed[],
  genre: Genre,
  preference?: SeedPreference,
  rng: RngLike = MATH_RNG,
): ClientSeed {
  const pool = seeds.filter((seed) => seedMatchesGenre(seed, genre));
  if (pool.length === 0) {
    throw new Error(`No seeds available for genre "${genre}".`);
  }
  if (preference && preference.verbs && preference.verbs.length > 0) {
    const verbs = new Set(preference.verbs);
    const matched = pool.filter((seed) => verbs.has(seed.verb ?? ''));
    if (matched.length === 0) {
      return rng.choice(pool);
    }
    const effectiveP = Math.min(preference.p ?? 0.5, matched.length / PULL_FLOOR);
    if (rng.random() < effectiveP) {
      return rng.choice(matched);
    }
    const matchedIds = new Set(matched.map((s) => s.id));
    const complement = pool.filter((s) => !matchedIds.has(s.id));
    if (complement.length === 0) {
      return rng.choice(pool);
    }
    return rng.choice(complement);
  }
  // No explicit preference: default genre stratification over a mixed pool.
  const specific = pool.filter((seed) => seed.genre.includes(genre));
  const agnosticOnly = pool.filter(
    (seed) => !seed.genre.includes(genre) && seed.genre.includes(GENRE_AGNOSTIC),
  );
  if (specific.length === 0 || agnosticOnly.length === 0) {
    return rng.choice(pool);
  }
  const effectiveP = Math.min(0.5, specific.length / PULL_FLOOR);
  if (rng.random() < effectiveP) {
    return rng.choice(specific);
  }
  const specificIds = new Set(specific.map((s) => s.id));
  const complement = pool.filter((s) => !specificIds.has(s.id));
  if (complement.length === 0) {
    return rng.choice(pool);
  }
  return rng.choice(complement);
}
export class StaticCoach implements Coach {
  private readonly seeds: ClientSeed[] | null;

  constructor(seeds?: ClientSeed[]) {
    this.seeds = seeds ?? null;
  }

  async ask(_textWindow: string, genre: Genre, _cursorOffset: number): Promise<string> {
    const seeds = this.seeds ?? (await loadSeeds());
    return pickSeed(seeds, genre).question;
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

/**
 * Build the coach for a mode. 'static' and 'local' are constructed here;
 * 'byok' is NOT — EditorApp owns ByokCoach construction (it must supply the
 * byok config UI wiring), so makeCoach throws for it rather than silently
 * misbehaving. The throw is unreachable in normal flow: the app never calls
 * makeCoach with 'byok'.
 */
export function makeCoach(mode: CoachMode): Coach {
  if (mode === 'byok') {
    throw new Error('byok mode constructs ByokCoach directly');
  }
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
