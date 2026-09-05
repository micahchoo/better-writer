/**
 * byok: bring-your-own-key — the reshape/gate pipeline run entirely in the
 * browser against an OpenAI-compatible provider. Deployed static (GitHub
 * Pages) there is no server, so the coach talks straight to the provider's
 * /chat/completions endpoint with a key the writer supplied.
 *
 * Key custody: the whole ByokConfig lives in localStorage under one key.
 * It is never logged and never sent anywhere except the configured baseUrl.
 * Calls are unauthenticated otherwise and time out after 60s.
 *
 * Selection, evidence verification, abstention, and retry policy are shared
 * with LocalCoach through the runtime-neutral coaching core. Only the transport differs —
 * the model request is made here instead of via the local server.
 */

import { loadSeeds, drawCandidates } from '../src/core/seeds';
import { decodeToMono16k, encodeWavPcm16 } from './dictation';
import { askFromCandidates } from '../src/core/agent';
import type { ClientSeed, Complete, Coach, CoachInput, CoachResult, Turn } from '../src/core/types';

const STORAGE_KEY = 'better-writer:byok';
const MAX_TOKENS = 512;
const TIMEOUT_MS = 60_000;

/** The OpenAI-compatible providers the dropdown offers, with their defaults. */
const PROVIDERS = ['openrouter', 'openai', 'groq', 'custom'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Default base URL per provider. `custom` starts empty because its URL is
 * writer-supplied. EditorApp reads this to populate its provider dropdown.
 */
export const PRESETS: Record<Provider, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  custom: '',
};

export interface ByokConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Optional dictation model. Absent on older saved configs (written before
   * dictation existed) and when the writer never set one; sttModelFor falls
   * back to a provider default in that case.
   */
  sttModel?: string;
}

/**
 * Default STT model per provider for dictation. OpenRouter is deliberately
 * absent — its API serves no audio route, so there is nothing to default to.
 */
export const STT_DEFAULTS: Partial<Record<Provider, string>> = {
  openai: 'whisper-1',
  groq: 'whisper-large-v3',
};

/** Whether each provider can transcribe audio at all (custom may, if the
 * writer's server implements the OpenAI audio route). */
export const TRANSCRIBES_AUDIO: Record<Provider, boolean> = {
  openrouter: false,
  openai: true,
  groq: true,
  custom: true,
};

/** Resolve the dictation model for a config: explicit override wins, else the
 * provider default. null means no dictation model is resolvable. */
export function sttModelFor(cfg: ByokConfig): string | null {
  return cfg.sttModel ?? STT_DEFAULTS[cfg.provider as Provider] ?? null;
}

/** Longest provider error body pasted into a message the writer will read. */
const MAX_ERROR_DETAIL = 200;

/**
 * Best-effort provider error text, bounded and stripped of markup.
 *
 * A non-ok response used to have its whole body pasted into the thrown
 * message, so a 502 HTML proxy page landed entire in a toast (H7-3). Keep
 * enough to diagnose, never enough to swamp the UI.
 */
async function errorDetail(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    return '';
  }
  const flat = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  return flat.length > MAX_ERROR_DETAIL ? `${flat.slice(0, MAX_ERROR_DETAIL)}…` : flat;
}

/**
 * Parse a JSON response body, turning a non-JSON 200 into a message about the
 * provider rather than a raw `SyntaxError: Unexpected token <` (H7-3).
 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  const body = await res.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    const flat = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DETAIL);
    throw new Error(`${what}: provider returned a non-JSON response — ${flat || '(empty body)'}`);
  }
}

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * True iff baseUrl is a parseable URL that is safe to POST a key to: https
 * always; http only for a loopback host, where the writer is on their own
 * machine (e.g. a local OpenAI-compatible server).
 */
export function isValidBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  // WHATWG URL keeps the brackets in an IPv6 hostname ('[::1]') — strip them
  // so a literal ::1 loopback matches alongside localhost / 127.0.0.1.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return url.protocol === 'https:' || (loopback && url.protocol === 'http:');
}

/** Strip trailing slashes so `${baseUrl}/chat/completions` never doubles one. */
function stripTrailingSlashes(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Validate an unknown parsed value into a ByokConfig, or null when it is
 * absent, misshapen, or fails validation. Provider must be known; all four
 * fields non-empty strings; the (slash-stripped) baseUrl must be a safe URL.
 */
function sanitize(value: unknown): ByokConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const { provider, baseUrl, apiKey, model, sttModel } = value as Record<string, unknown>;
  if (typeof provider !== 'string' || !isProvider(provider)) return null;
  // TRIM before every emptiness test (H7-1). The in-app form trims on save,
  // so a padded value only arrives from hand-edited or hostile localStorage —
  // but then sanitize used to CERTIFY a config that can never work: a baseUrl
  // of "https://api.openai.com/v1 " assembles a request path of
  // "/v1%20/chat/completions", a guaranteed 404, and a padded key is sent as
  // a padded key. Falling back to setup is the honest outcome; blessing a
  // broken config is not.
  if (typeof baseUrl !== 'string') return null;
  if (typeof apiKey !== 'string') return null;
  if (typeof model !== 'string') return null;
  const trimmedKey = apiKey.trim();
  const trimmedModel = model.trim();
  if (trimmedKey.length === 0 || trimmedModel.length === 0) return null;
  const normalized = stripTrailingSlashes(baseUrl.trim());
  if (normalized.length === 0) return null;
  if (!isValidBaseUrl(normalized)) return null;
  const out: ByokConfig = {
    provider,
    baseUrl: normalized,
    apiKey: trimmedKey,
    model: trimmedModel,
  };
  // sttModel is optional: keep it only as a non-empty string AFTER trimming,
  // so a corrupted, absent, or whitespace-only value degrades to "no dictation
  // model" rather than reading as truthy. Old configs (no key) still load.
  if (typeof sttModel === 'string' && sttModel.trim().length > 0) {
    out.sttModel = sttModel.trim();
  }
  return out;
}

/**
 * Read the saved config, or null when it is absent, corrupt, fails
 * validation, or storage is disabled (private browsing / file://). Fail soft:
 * any storage or parse problem means "not configured", never a throw.
 */
export function loadByokConfig(): ByokConfig | null {
  let raw: string;
  try {
    raw = localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return null; // storage disabled
  }
  if (raw === '') return null;
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return null; // corrupt JSON
  }
}

/**
 * Persist the config, or clear it when given null. Quota/security errors are
 * swallowed so a full or locked store degrades to "not configured" rather
 * than interrupting the writer — same fail-soft posture as genre persistence.
 */
export function saveByokConfig(cfg: ByokConfig | null): void {
  try {
    if (cfg === null) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const normalized = { ...cfg, baseUrl: stripTrailingSlashes(cfg.baseUrl) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // swallow quota/security errors — fail soft
  }
}

/**
 * A Complete backed by an OpenAI-compatible provider. Maps (system, turns)
 * to chat messages with the same user/assistant roles as the local transport.
 */
export function makeByokComplete(cfg: ByokConfig): Complete {
  return async (system: string, turns: Turn[], opts?: { temperature?: number; signal?: AbortSignal }): Promise<string> => {
    opts?.signal?.throwIfAborted();
    const messages = [
      { role: 'system', content: system },
      ...turns.map(turn => ({ role: turn.role === 'agent' ? 'assistant' : 'user', content: turn.text })),
    ];
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts?.temperature ?? 0.7,
        max_tokens: MAX_TOKENS,
      }),
      signal: opts?.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await errorDetail(res);
      const suffix = detail ? ` — ${detail}` : '';
      throw new Error(`BYOK coach request failed: ${res.status} ${res.statusText}${suffix}`);
    }
    const data = await readJson<{
      choices?: Array<{ message?: { content?: string } }>;
    }>(res, 'BYOK coach request failed');
    return (data.choices?.[0]?.message?.content ?? '').trim();
  };
}

/**
 * Transcribe a recorded blob through the writer's own provider. Just like the
 * local route, the raw recorder bytes (webm/opus, mp4/aac) are first decoded
 * to 16kHz mono and wrapped in a RIFF/WAVE header, so both paths send the
 * same WAV shape to their transport. Requires a configured dictation model
 * (sttModelFor) AND a provider that TRANSCRIBES_AUDIO — openrouter has no
 * audio route, so both checks throw before any network call.
 */
export async function transcribeWavByok(blob: Blob, config?: ByokConfig | null): Promise<string> {
  const cfg = config === undefined ? loadByokConfig() : config;
  if (!cfg) {
    throw new Error('No API key configured — add your key in settings');
  }
  // TRANSCRIBES_AUDIO is the contract, so ENFORCE it before the network call
  // (H7-2). Guarding only on sttModelFor let a stale override defeat it: the
  // provider switch preserves the sttModel field, so openai -> openrouter
  // leaves "whisper-1" behind and the writer's API key was POSTed to a route
  // that does not exist.
  if (!TRANSCRIBES_AUDIO[cfg.provider as Provider]) {
    throw new Error(`${cfg.provider} cannot transcribe audio — switch provider to dictate`);
  }
  const model = sttModelFor(cfg);
  if (!model) {
    throw new Error('No dictation model for this provider — set one in BYOK settings');
  }
  // Convert the recorder's raw bytes to the WAV the provider's
  // /audio/transcriptions route expects — the same conversion the local path
  // performs. Provider APIs sniff by extension as well as content, so a .wav
  // file must actually carry RIFF bytes or the request is rejected.
  const mono = await decodeToMono16k(blob);
  const wav = encodeWavPcm16(mono, 16000);
  const body = new FormData();
  body.append('file', wav, 'dictation.wav');
  body.append('model', model);
  body.append('response_format', 'json');
  const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    // No manual Content-Type: the browser sets the multipart boundary.
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await errorDetail(res);
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(`Dictation request failed: ${res.status} ${res.statusText}${suffix}`);
  }
  const data = await readJson<{ text?: string }>(res, 'Dictation request failed');
  return (data.text ?? '').trim();
}

/**
 * The byok coach: picks a seed verbatim (same selection as StaticCoach), then
 * reshapes it in the browser against the configured provider, then gates the
 * output — falling back to a topic probe on failure, exactly like LocalCoach.
 * EditorApp constructs it (not makeCoach), wiring the config UI.
 */
export class ByokCoach implements Coach {
  private readonly seeds: ClientSeed[] | null;
  private readonly complete: Complete | null;

  constructor(deps?: { seeds?: ClientSeed[]; complete?: Complete; config?: ByokConfig }) {
    this.seeds = deps?.seeds ?? null;
    const config = deps?.config ?? loadByokConfig();
    // Freeze the connection for this adapter's lifetime. A settings change
    // constructs another adapter and cancels the previous coaching session.
    this.complete = deps?.complete ?? (config ? makeByokComplete({ ...config }) : null);
  }

  async ask(input: CoachInput, signal?: AbortSignal): Promise<CoachResult> {
    signal?.throwIfAborted();
    if (!this.complete) return { kind: 'unavailable', retryable: false };
    const seeds = this.seeds ?? await loadSeeds();
    signal?.throwIfAborted();
    const candidates = drawCandidates(seeds, input);
    return askFromCandidates(input, candidates.map(seed => seed.question), this.complete, signal);
  }
}
