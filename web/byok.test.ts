import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSeed } from '../src/types';
import {
  ByokCoach,
  loadByokConfig,
  makeByokComplete,
  PRESETS,
  saveByokConfig,
  STT_DEFAULTS,
  sttModelFor,
  TRANSCRIBES_AUDIO,
  transcribeWavByok,
} from './byok';

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
    const question = await coach.ask(TEXT_WINDOW, 'poetry', 0);

    expect(question).toBe(VALID_QUESTION);
    // The reshape prompt must contain the POETRY seed's question, proving the
    // fiction seed was excluded by the genre filter.
    const body = storedBody(fetchFn);
    expect(body.messages[1].content).toContain(poetrySeed.question);
    expect(body.messages[1].content).not.toContain(fictionSeed.question);
  });

  it('throws and never calls fetch when no config is saved', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);

    const coach = new ByokCoach({ seeds: [fictionSeed] });
    await expect(coach.ask(TEXT_WINDOW, 'fiction', 0)).rejects.toThrow(/No API key configured/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses an injected complete without touching config or fetch', async () => {
    const complete = vi.fn(async () => VALID_QUESTION);
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);

    const coach = new ByokCoach({ seeds: [fictionSeed], complete });
    const question = await coach.ask(TEXT_WINDOW, 'fiction', 0);

    expect(question).toBe(VALID_QUESTION);
    expect(coach.lastSource()).toBe('reshaped');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('sttModel & sanitize back-compat', () => {
  it('loads a saved config that has no sttModel (written before dictation)', () => {
    saveByokConfig(makeConfig());
    expect(loadByokConfig()?.sttModel).toBeUndefined();
    expect(loadByokConfig()?.model).toBe('gpt-4o-mini');
  });

  it('survives a round-trip when sttModel is set', () => {
    saveByokConfig(makeConfig({ sttModel: 'whisper-1' }));
    expect(loadByokConfig()?.sttModel).toBe('whisper-1');
  });

  it('drops a non-string sttModel instead of breaking the config', () => {
    // A corrupted stored value (e.g. a number or object) must be dropped, not
    // rejected — the rest of the config still loads.
    const stored = JSON.stringify({ ...makeConfig(), sttModel: 42 });
    localStorage.setItem(KEY, stored);
    const cfg = loadByokConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.sttModel).toBeUndefined();
  });
});

describe('sttModelFor', () => {
  it('prefers an explicit override over the provider default', () => {
    expect(sttModelFor(makeConfig({ sttModel: 'my-custom-whisper' }))).toBe('my-custom-whisper');
  });

  it('returns the provider default when no override is set', () => {
    expect(sttModelFor(makeConfig({ provider: 'openai' }))).toBe('whisper-1');
    const groq = { ...makeConfig(), provider: 'groq' };
    expect(sttModelFor(groq)).toBe('whisper-large-v3');
  });

  it('returns null when the provider has no default and none is set', () => {
    // OpenRouter serves no audio route — deliberately no default.
    const openrouter = { ...makeConfig(), provider: 'openrouter' };
    expect(sttModelFor(openrouter)).toBeNull();
    // Custom has no default either; a writer-supplied model is required.
    const custom = { ...makeConfig(), provider: 'custom' };
    expect(sttModelFor(custom)).toBeNull();
  });

  it('STT_DEFAULTS / TRANSCRIBES_AUDIO agree on which providers can dictate', () => {
    expect(STT_DEFAULTS.openai).toBe('whisper-1');
    expect(STT_DEFAULTS.groq).toBe('whisper-large-v3');
    expect(STT_DEFAULTS.openrouter).toBeUndefined();
    expect(TRANSCRIBES_AUDIO).toEqual({
      openrouter: false,
      openai: true,
      groq: true,
      custom: true,
    });
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
