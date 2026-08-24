import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSeed } from '../src/types';
import {
  ByokCoach,
  loadByokConfig,
  isValidBaseUrl,
  makeByokComplete,
  PRESETS,
  saveByokConfig,
  STT_DEFAULTS,
  sttModelFor,
  TRANSCRIBES_AUDIO,
  transcribeWavByok,
} from './byok';
import { decodeToMono16k, encodeWavPcm16 } from './dictation';
import * as DictationNs from './dictation';

// Node has no AudioContext, so the decode step (which resamples via
// OfflineAudioContext) is stubbed; the real encoder still runs so the
// uploaded WAV bytes are genuinely RIFF. This lets the conversion tests prove
// the transcribeWavByok seam converts before it appends.
vi.mock('./dictation', async (importOriginal) => {
  const actual = await importOriginal<typeof DictationNs>();
  return {
    ...actual,
    decodeToMono16k: vi.fn(async () => new Float32Array(16000)),
    encodeWavPcm16: vi.fn((samples: Float32Array, sampleRate: number) =>
      actual.encodeWavPcm16(samples, sampleRate),
    ),
  };
});

const KEY = 'better-writer:byok';

// Realistic craft prose so the grounding gate can pass (see memory: smoke
// tests need real prose, not toy text, or the anchor never grounds).
const TEXT_WINDOW =
  'The lighthouse keeper winds the clock every morning, a ritual that steadies his hands against the dark.';

// Passes the full gate against TEXT_WINDOW: single '?' at the end, no newline,
// shares "keeper" (grounded), echoes no text bigram, copies no seed word.
const VALID_QUESTION = 'What does the keeper fear will fail him when the light goes out?';

const fictionSeed: ClientSeed = {
  id: 's1',
  question: 'Why does a steady ritual calm the nervous hand?',
  genre: ['fiction'],
};
const poetrySeed: ClientSeed = {
  id: 'p1',
  question: 'What music hides behind the closed door?',
  genre: ['poetry'],
};

function makeConfig(
  overrides: Partial<{
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    sttModel?: string;
  }> = {},
) {
  return {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

/** A fetch stub returning an OpenAI-style /chat/completions response. */
function stubFetch(content: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The chat-completions request body as captured by the fetch stub. */
interface ChatBody {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: string; content: string }>;
}

function storedBody(fn: ReturnType<typeof vi.fn>): ChatBody {
  const [, init] = fn.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as ChatBody;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('isValidBaseUrl (save-time policy)', () => {
  it('accepts https for any host', () => {
    expect(isValidBaseUrl('https://api.openai.com/v1')).toBe(true);
    expect(isValidBaseUrl('https://openrouter.ai/api/v1')).toBe(true);
  });

  it('accepts http only for exact loopback hostnames', () => {
    expect(isValidBaseUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isValidBaseUrl('http://[::1]:11434/v1')).toBe(true);
    // A DNS-rebinding name that resolves to loopback keeps its hostname
    // string, so the policy still rejects it.
    expect(isValidBaseUrl('http://evil.example:11434/v1')).toBe(false);
    expect(isValidBaseUrl('http://localhost.attacker.com')).toBe(false);
  });

  it('rejects values that do not parse as URLs', () => {
    expect(isValidBaseUrl('not a url')).toBe(false);
    expect(isValidBaseUrl('')).toBe(false);
  });
});

describe('PRESETS', () => {
  it('maps every provider to its default base URL', () => {
    expect(PRESETS.openrouter).toBe('https://openrouter.ai/api/v1');
    expect(PRESETS.openai).toBe('https://api.openai.com/v1');
    expect(PRESETS.groq).toBe('https://api.groq.com/openai/v1');
    expect(PRESETS.custom).toBe('');
  });
});

describe('config round-trip', () => {
  it('saves, loads, and clears a config', () => {
    const cfg = makeConfig();
    saveByokConfig(cfg);
    expect(loadByokConfig()).toEqual(cfg);

    saveByokConfig(null);
    expect(loadByokConfig()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(loadByokConfig()).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    localStorage.setItem(KEY, '{not valid json');
    expect(loadByokConfig()).toBeNull();
  });

  it('strips trailing slashes from baseUrl (save and load)', () => {
    saveByokConfig(makeConfig({ baseUrl: 'https://api.openai.com/v1///' }));
    expect(loadByokConfig()?.baseUrl).toBe('https://api.openai.com/v1');

    // A trailing slash already in storage is normalized on load too.
    localStorage.setItem(KEY, JSON.stringify(makeConfig({ baseUrl: 'https://openrouter.ai/api/v1/' })));
    expect(loadByokConfig()?.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('rejects an unknown provider', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ provider: 'bogus', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' }),
    );
    expect(loadByokConfig()).toBeNull();
  });

  it('rejects a non-https baseUrl that is not a loopback host', () => {
    localStorage.setItem(KEY, JSON.stringify(makeConfig({ baseUrl: 'http://api.example.com/v1' })));
    expect(loadByokConfig()).toBeNull();
  });

  it('allows http for a localhost custom provider', () => {
    const cfg = { provider: 'custom', baseUrl: 'http://localhost:11434/v1', apiKey: 'k', model: 'm' };
    saveByokConfig(cfg);
    expect(loadByokConfig()?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('rejects a baseUrl that does not parse as a URL', () => {
    localStorage.setItem(KEY, JSON.stringify(makeConfig({ baseUrl: 'not a url' })));
    expect(loadByokConfig()).toBeNull();
  });

  it('returns null when storage is disabled', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
    });
    expect(loadByokConfig()).toBeNull();
  });
});

describe('makeByokComplete', () => {
  it('POSTs the chat-completions shape and returns trimmed content', async () => {
    const fetchFn = stubFetch('  What does the keeper fear?  ');
    const complete = makeByokComplete(makeConfig());

    const result = await complete('the system', [{ role: 'user', text: 'the prompt' }]);

    expect(result).toBe('What does the keeper fear?');

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.7);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe('the system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('the prompt');
  });

  it('joins multiple turns with blank lines and honors a custom temperature', async () => {
    const fetchFn = stubFetch('ok');
    const complete = makeByokComplete(makeConfig());
    await complete('sys', [{ role: 'user', text: 'one' }, { role: 'agent', text: 'two' }], {
      temperature: 0.1,
    });
    const body = storedBody(fetchFn);
    expect(body.temperature).toBe(0.1);
    expect(body.messages[1].content).toBe('one\n\ntwo');
  });

  it('throws with status and provider text on a non-ok response', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid api key',
    }));
    vi.stubGlobal('fetch', fetchFn);

    const complete = makeByokComplete(makeConfig());
    await expect(complete('sys', [{ role: 'user', text: 'p' }])).rejects.toThrow(
      /401.*invalid api key/,
    );
  });

  it('throws even when the error body is unreadable', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () => {
        throw new Error('unreadable');
      },
    }));
    vi.stubGlobal('fetch', fetchFn);

    const complete = makeByokComplete(makeConfig());
    await expect(complete('sys', [{ role: 'user', text: 'p' }])).rejects.toThrow(/429/);
  });
});

describe('ByokCoach.ask', () => {
  it('reshapes a seed against the window and reports lastSource "reshaped"', async () => {
    saveByokConfig(makeConfig());
    const fetchFn = stubFetch(VALID_QUESTION);

    const coach = new ByokCoach({ seeds: [fictionSeed] });
    const question = await coach.ask(TEXT_WINDOW, 'fiction', 0);

    expect(question).toBe(VALID_QUESTION);
    expect(coach.lastSource()).toBe('reshaped');

    // The request body carries the seed's question through the reshape prompt.
    const body = storedBody(fetchFn);
    expect(body.messages[1].content).toContain(fictionSeed.question);
  });

  it('falls back to a topic probe when the model output fails the gate twice', async () => {
    saveByokConfig(makeConfig());
    const fetchFn = stubFetch('yes'); // not a single question -> syntax failure, twice

    const coach = new ByokCoach({ seeds: [fictionSeed] });
    const question = await coach.ask(TEXT_WINDOW, 'fiction', 0);

    expect(fetchFn).toHaveBeenCalledTimes(2); // first attempt + one retry
    expect(coach.lastSource()).toBe('topic-probe');
    expect(question).toBeTruthy();
    expect(question.endsWith('?')).toBe(true);
  });

  it('honors the genre filter when picking the seed', async () => {
    saveByokConfig(makeConfig());
    const fetchFn = stubFetch(VALID_QUESTION);

    const coach = new ByokCoach({ seeds: [fictionSeed, poetrySeed] });
    const question = await coach.ask(TEXT_WINDOW, 'fiction', 0);

    expect(question).toBe(VALID_QUESTION);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('sttModel & sanitize back-compat', () => {
  it('uses an explicit sttModel even when the provider also has a default', () => {
    saveByokConfig(makeConfig({ sttModel: 'whisper-1' }));
    expect(sttModelFor(loadByokConfig()!)).toBe('whisper-1');
  });

  it('falls back to the provider default when sttModel is absent', () => {
    saveByokConfig(makeConfig()); // openai
    expect(sttModelFor(loadByokConfig()!)).toBe(STT_DEFAULTS.openai);
  });

  it('returns null when the provider has no default and no explicit sttModel', () => {
    saveByokConfig(makeConfig({ provider: 'openrouter' }));
    expect(sttModelFor(loadByokConfig()!)).toBeNull();
  });
});

describe('sttModelFor', () => {
  it('returns the explicit sttModel when set', () => {
    expect(sttModelFor(makeConfig({ sttModel: 'whisper-1' }))).toBe('whisper-1');
  });

  it('falls back to the provider default', () => {
    expect(sttModelFor(makeConfig())).toBe(STT_DEFAULTS.openai);
  });

  it('returns null when the provider has no default', () => {
    expect(sttModelFor(makeConfig({ provider: 'openrouter' }))).toBeNull();
  });
});

describe('transcribeWavByok', () => {
  const WAV = new Blob(['fake-wav-bytes'], { type: 'audio/wav' });

  it('POSTs the audio-transcriptions shape and returns trimmed text', async () => {
    saveByokConfig(makeConfig()); // openai -> default whisper-1
    const fetchFn = vi.fn(async (_input: unknown, _init: unknown) => ({
      ok: true,
      json: async () => ({ text: '  the keeper winds the clock  ' }),
    }));
    vi.stubGlobal('fetch', fetchFn);

    const text = await transcribeWavByok(WAV);

    expect(text).toBe('the keeper winds the clock');

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit & { body: FormData }];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    // No manual Content-Type: the browser must set the multipart boundary.
    expect(init.headers).not.toHaveProperty('Content-Type');

    const body = init.body;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('model')).toBe('whisper-1');
    expect(body.get('response_format')).toBe('json');
    const file = body.get('file') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe('dictation.wav');
  });

  it('converts the raw recorder blob to 16kHz mono WAV before upload', async () => {
    saveByokConfig(makeConfig()); // openai -> default whisper-1
    const raw = new Blob(['fake-webm-opus-bytes'], { type: 'audio/webm;codecs=opus' });
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ text: 'ok' }) }));
    vi.stubGlobal('fetch', fetchFn);

    const text = await transcribeWavByok(raw);

    expect(text).toBe('ok');
    // The seam decodes the raw recorder bytes, then re-encodes to WAV.
    expect(decodeToMono16k).toHaveBeenCalledWith(raw);
    expect(encodeWavPcm16).toHaveBeenCalledWith(expect.any(Float32Array), 16000);

    const init = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const file = (init[1].body as FormData).get('file') as File;
    // The uploaded file is the converted WAV, not the raw WebM blob.
    expect(file).not.toBe(raw);
    expect(file.type).toBe('audio/wav');
    // jsdom's File exposes no arrayBuffer(), so prove the bytes via the WAV
    // size signature: a 44-byte RIFF/WAVE header + 16k mono PCM16 samples.
    // The raw 'fake-webm-opus-bytes' input (21 bytes) could never match this.
    expect(file.size).toBe(44 + 16000 * 2);
  });

  it('throws with status and provider text on a non-ok response', async () => {
    saveByokConfig(makeConfig({ sttModel: 'whisper-1' }));
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid api key',
    }));
    vi.stubGlobal('fetch', fetchFn);

    await expect(transcribeWavByok(WAV)).rejects.toThrow(/401.*invalid api key/);
  });

  it('throws and never calls fetch when no config is saved', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);

    await expect(transcribeWavByok(WAV)).rejects.toThrow(/No API key configured/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws and never calls fetch when the provider has no dictation model', async () => {
    saveByokConfig(makeConfig({ provider: 'openrouter' }));
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);

    await expect(transcribeWavByok(WAV)).rejects.toThrow(/No dictation model/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
