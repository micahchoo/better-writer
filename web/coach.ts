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

import type { ClientSeed, Coach, CoachInput, CoachResult } from '../src/core/types';
import { parseCoachResult } from '../src/core/contract';
import { loadSeeds, pickSeed } from '../src/core/seeds';
export type { Coach } from '../src/core/types';


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

export { loadSeeds, pickSeed, seedMatchesGenre } from '../src/core/seeds';
export type { RngLike, SeedPreference } from '../src/core/seeds';

export class StaticCoach implements Coach {
  constructor(private readonly seeds?: ClientSeed[]) {}

  async ask(input: CoachInput, signal?: AbortSignal): Promise<CoachResult> {
    signal?.throwIfAborted();
    const seeds = this.seeds ?? await loadSeeds();
    signal?.throwIfAborted();
    return { kind: 'question', question: pickSeed(seeds, input.genre).question, source: 'seed' };
  }
}

export class LocalCoach implements Coach {
  constructor(private readonly endpoint = '') {}

  async ask(input: CoachInput, signal?: AbortSignal): Promise<CoachResult> {
    signal?.throwIfAborted();
    try {
      const res = await fetch(`${this.endpoint}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
      });
      signal?.throwIfAborted();
      if (!res.ok) return { kind: 'unavailable', retryable: res.status >= 500 || res.status === 429 };
      const data: unknown = await res.json();
      signal?.throwIfAborted();
      return parseCoachResult(data, input);
    } catch {
      signal?.throwIfAborted();
      return { kind: 'unavailable', retryable: true };
    }
  }
}

/** Construct a detected coach. BYOK requires its own explicit connection settings. */
export function makeCoach(mode: 'static' | 'local'): Coach {
  return mode === 'local' ? new LocalCoach() : new StaticCoach();
}

/**
 * Probe the local server. Resolves 'local' only for a 200 response with a
 * JSON content type (a real Hono server); everything else — 404, an SPA
 * fallback page, a timeout, or a network error — resolves 'static'.
 */
export async function detectServerMode(timeoutMs = 1000): Promise<'static' | 'local'> {
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
