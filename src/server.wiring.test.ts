import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { CoachInput } from './core/types';
const { complete, loadSeeds } = vi.hoisted(() => ({ complete: vi.fn(), loadSeeds: vi.fn() }));
vi.mock('./llm', () => ({ makeComplete: () => complete }));
vi.mock('./core/seeds', async (original) => ({ ...await original<typeof import('./core/seeds')>(), loadSeeds }));
import * as server from './server';

beforeEach(() => {
  complete.mockReset();
  loadSeeds.mockReset().mockResolvedValue([
    { id: 'setting', question: 'What does the setting reveal about the conflict?', genre: ['genre-agnostic'], verb: 'elaborate' },
    { id: 'senses', question: 'How might sensory details carry emotional weight?', genre: ['genre-agnostic'], verb: 'rephrase' },
  ]);
});

/** A minimal PCM16 mono 16 kHz WAV payload holding `sampleCount` samples. */
function minimalWav(sampleCount: number): Uint8Array {
  const dataSize = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16000, true); // sample rate
  view.setUint32(28, 32000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return bytes;
}

describe('SIGINT/SIGTERM shutdown (S1-3: STT worker must not orphan on kill)', () => {
  function makeShim() {
    const handlers: Record<string, () => void> = {};
    const exitCodes: number[] = [];
    let disposeCount = 0;
    const shim = {
      on(event: string, handler: () => void) {
        handlers[event] = handler;
      },
      exit(code?: number) {
        exitCodes.push(code ?? 0);
      },
    };
    return {
      shim,
      handlers,
      exitCodes,
      dispose: () => {
        disposeCount += 1;
      },
      disposeCount: () => disposeCount,
    };
  }

  it('disposes the worker and exits 0 on SIGTERM', () => {
    const { shim, handlers, dispose, exitCodes, disposeCount } = makeShim();
    server.registerShutdownHandlers(shim, dispose);
    handlers['SIGTERM']();
    expect(disposeCount()).toBe(1);
    expect(exitCodes).toEqual([0]);
  });

  it('disposes on SIGINT as well', () => {
    const { shim, handlers, dispose, disposeCount } = makeShim();
    server.registerShutdownHandlers(shim, dispose);
    handlers['SIGINT']();
    expect(disposeCount()).toBe(1);
  });

  it('a second signal never re-disposes or re-exits (double-invocation guard)', () => {
    const { shim, handlers, dispose, exitCodes, disposeCount } = makeShim();
    server.registerShutdownHandlers(shim, dispose);
    handlers['SIGTERM']();
    handlers['SIGINT']();
    handlers['SIGTERM']();
    expect(disposeCount()).toBe(1);
    expect(exitCodes).toEqual([0]);
  });
});

describe('/transcribe content-type anchor (S3-6: media type before parameters)', () => {
  it("rejects a media type smuggled into parameters — the substring bug", async () => {
    const res = await server.app.request('/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=audio/wave' },
      body: new Uint8Array([1, 2, 3]) as BodyInit,
    });
    // 400, not 503: the guard returns before resolveModelDir/transcribe, so
    // the recognizer is never touched even when no model is configured.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'expected Content-Type audio/wav' });
  });

  it('does not let audio/wav match the longer audio/wave form', async () => {
    // audio/wave is itself a valid WAV type, but audio/wav is NOT a valid
    // prefix of audio/waves — the \b boundary stops that leak.
    const bad = await server.app.request('/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wavfile' },
      body: new Uint8Array([1, 2, 3]) as BodyInit,
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'expected Content-Type audio/wav' });
  });

  it('accepts audio/wav with parameters (the decode then rejects the junk body)', async () => {
    const res = await server.app.request('/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav; charset=utf-8' },
      body: new Uint8Array([1, 2, 3]) as BodyInit,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('invalid WAV');
  });
});

describe('/transcribe minimum-length floor (S3-7: no raw ONNX toast)', () => {
  it('returns a plain-language 400, not 503 ONNX text, for a 4-sample WAV', async () => {
    const res = await server.app.request('/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: minimalWav(4) as BodyInit,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('recording too short');
    expect(body.error).not.toContain('ConvInteger');
  });
});

describe('/save JSON parsing (S4-9: distinguish parse failure from bad field)', () => {
  it("says 'invalid JSON body' for a non-JSON body", async () => {
    const res = await server.app.request('/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid JSON body' });
  });

  it('keeps the wrong-type message for a valid JSON object with a bad draft', async () => {
    const res = await server.app.request('/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: 42 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'draft must be a string' });
  });
});

describe('/ask shared agent wiring', () => {
  const input: CoachInput = {
    textWindow: 'Morning came. Her copper kettle stayed cold.', genre: 'fiction', cursorOffset: 100,
    focus: { start: 14, end: 43 }, position: { sectionBlockCount: 10, blockIndexInSection: 5 },
  };
  const request = (body: unknown = input) => server.app.request('/ask', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const valid = { kind: 'question', candidate: 1, question: 'What do you want the "copper kettle" to suggest about her reluctance?', quote: 'copper kettle' };

  it('uses candidate selection and returns grounded window-relative evidence', async () => {
    complete.mockResolvedValue(JSON.stringify(valid));
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'question', question: valid.question, source: 'reshaped', evidence: { quote: 'copper kettle', start: 18, end: 31 } });
    const prompt = complete.mock.calls[0][1][0].text;
    expect(prompt).toContain('What does the setting reveal');
    expect(prompt).toContain('How might sensory details');
    expect(prompt).toContain('Her copper kettle stayed cold.');
    expect(complete.mock.calls[0][2].signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves explicit no-fit without retry', async () => {
    complete.mockResolvedValue('{"kind":"skip"}');
    expect(await (await request()).json()).toEqual({ kind: 'skip', reason: 'no-fit' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('returns invalid-output after two malformed answers', async () => {
    complete.mockResolvedValue('unstructured advice');
    expect(await (await request()).json()).toEqual({ kind: 'skip', reason: 'invalid-output' });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('keeps model outages distinct from skip and performs no retry', async () => {
    complete.mockRejectedValue(new Error('private provider details'));
    expect(await (await request()).json()).toEqual({ kind: 'unavailable', retryable: true });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('reports seed-loading failure as unavailable without internal details', async () => {
    loadSeeds.mockRejectedValue(new Error('private filesystem path'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ kind: 'unavailable', retryable: true });
      expect(complete).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it.each([
    { text_window: input.textWindow, genre: 'fiction' },
    { ...input, focus: { start: -1, end: 20 } },
    { ...input, focus: { start: 5, end: 999 } },
    { ...input, position: { sectionBlockCount: 2, blockIndexInSection: 2 } },
    { ...input, cursorOffset: 0.5 },
    { ...input, genre: 'wrong' },
  ])('rejects malformed request before loading seeds', async body => {
    expect((await request(body)).status).toBe(400);
    expect(loadSeeds).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
