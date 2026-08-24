import { describe, expect, it, beforeAll } from 'vitest';
import type * as ServerModule from './server';
import { buildAskWindow } from '../web/text-window.js';
import { measureWindow } from '../web/window-stats.js';

// server.ts binds a real socket at module load (BW_PORT, default 4517). Point
// it at an isolated port so importing the module never touches the live
// origin — and never POSTs anything to it, so no data writes.
let server: typeof ServerModule;

// The module must be imported AFTER BW_PORT is set, or it would bind the live
// 4517 port: static import evaluates the module before this file's body runs,
// so only a runtime import can observe the env override.
beforeAll(async () => {
  process.env.BW_PORT = '49874';
  server = await import('./server');
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

describe('local /ask position wiring (S2-10: opening/closing axes fire)', () => {
  const blocks = ['Alpha one.', 'Beta two.', 'Gamma three.'];

  it('fires opening-position when the cursor block opens its section', () => {
    const win = buildAskWindow(blocks, 0);
    expect(server.derivePositionContext(win)).toEqual({ sectionBlockCount: 3, blockIndexInSection: 0 });
    const stats = measureWindow(win, server.derivePositionContext(win) ?? undefined);
    expect(stats.axes.has('opening-position')).toBe(true);
    expect(stats.axes.has('closing-position')).toBe(false);
  });

  it('fires closing-position when the cursor block closes its section', () => {
    const win = buildAskWindow(blocks, 2);
    expect(server.derivePositionContext(win)).toEqual({ sectionBlockCount: 3, blockIndexInSection: 2 });
    const stats = measureWindow(win, server.derivePositionContext(win) ?? undefined);
    expect(stats.axes.has('closing-position')).toBe(true);
    expect(stats.axes.has('opening-position')).toBe(false);
  });

  it('fires neither for a cursor block in the middle of its section', () => {
    const win = buildAskWindow(blocks, 1);
    expect(server.derivePositionContext(win)).toEqual({ sectionBlockCount: 3, blockIndexInSection: 1 });
    const stats = measureWindow(win, server.derivePositionContext(win) ?? undefined);
    expect(stats.axes.has('opening-position')).toBe(false);
    expect(stats.axes.has('closing-position')).toBe(false);
  });
});
