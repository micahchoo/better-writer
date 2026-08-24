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
 * The reshape/gate semantics are identical to LocalCoach's: a seed question
 * is specialized by the model, the output must pass the same gate, and on a
 * gate failure it falls back to a topic probe. Only the transport differs —
 * the model request is made here instead of via the local server.
 */

import { loadSeeds, pickSeed, type Coach } from './coach';
import { decodeToMono16k, encodeWavPcm16 } from './dictation';
import { reshape } from '../src/reshape';
import type { ClientSeed, Complete, Genre, QuestionSource, Turn } from '../src/types';

const STORAGE_KEY = 'better-writer:byok';
const MAX_TOKENS = 256;
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
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return null;
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  const normalized = stripTrailingSlashes(baseUrl);
  if (!isValidBaseUrl(normalized)) return null;
  const out: ByokConfig = { provider, baseUrl: normalized, apiKey, model };
  // sttModel is optional: keep it only as a non-empty string, so a corrupted
  // or absent value degrades to "no dictation model" rather than breaking
  // the whole config. Old saved configs (no sttModel key) still load.
  if (typeof sttModel === 'string' && sttModel.length > 0) out.sttModel = sttModel;
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
 * to chat messages the same way the local pipeline does: a single system
 * message plus the user turns joined by blank lines.
 */
export function makeByokComplete(cfg: ByokConfig): Complete {
  return async (system: string, turns: Turn[], opts?: { temperature?: number }): Promise<string> => {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: turns.map((t) => t.text).join('\n\n') },
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        // best-effort provider error text; ignore if the body is unreadable
      }
      const suffix = detail ? ` — ${detail}` : '';
      throw new Error(`BYOK coach request failed: ${res.status} ${res.statusText}${suffix}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  };
}

/**
 * Transcribe a recorded blob through the writer's own provider. Just like the
 * local route, the raw recorder bytes (webm/opus, mp4/aac) are first decoded
 * to 16kHz mono and wrapped in a RIFF/WAVE header, so both paths send the
 * same WAV shape to their transport. Requires a configured dictation model
 * (sttModelFor) — openrouter has no audio route, so there is never a model to
 * use and this throws before any network call.
 */
export async function transcribeWavByok(blob: Blob): Promise<string> {
  const cfg = loadByokConfig();
  if (!cfg) {
    throw new Error('No API key configured — add your key in settings');
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
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // best-effort provider error text; ignore if the body is unreadable
    }
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(`Dictation request failed: ${res.status} ${res.statusText}${suffix}`);
  }
  const data = (await res.json()) as { text?: string };
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

  /** Provenance of the last resolved ask; null until one resolves. */
  private last: QuestionSource | null = null;

  constructor(deps?: { seeds?: ClientSeed[]; complete?: Complete }) {
    this.seeds = deps?.seeds ?? null;
    this.complete = deps?.complete ?? null;
  }

  /** The Complete to reshape with: an injected one, else the saved config. */
  private completeFor(): Complete {
    if (this.complete) return this.complete;
    const cfg = loadByokConfig();
    if (!cfg) {
      throw new Error('No API key configured — add your key in settings');
    }
    return makeByokComplete(cfg);
  }

  async ask(textWindow: string, genre: Genre, _cursorOffset: number): Promise<string> {
    const seeds = this.seeds ?? (await loadSeeds());
    const seedQuestion = pickSeed(seeds, genre).question;
    const { question, source } = await reshape(seedQuestion, textWindow, this.completeFor());
    this.last = source;
    return question;
  }

  lastSource(): QuestionSource | null {
    return this.last;
  }
}
