import { describe, expect, it, beforeAll } from 'vitest';
import type * as ServerModule from './server';

// server.ts binds a real socket at module load (BW_PORT, default 4517). Point
// it at an isolated port so importing the module for its pure helpers never
// touches the live origin — and never POSTs anything to it, so no data writes.
let server: typeof ServerModule;

// The module must be imported AFTER BW_PORT is set, or it would bind the live
// 4517 port: static import evaluates the module before this file's body runs,
// so only a runtime import can observe the env override.
beforeAll(async () => {
  process.env.BW_PORT = '49873';
  server = await import('./server');
});

describe('adapterBody (#5: GET/HEAD with a body must not 500)', () => {
  it('omits the body for GET — the exact case undici used to throw on', () => {
    const body = Buffer.from('hi');
    // Constructing the request is the throwing site that produced the 500.
    expect(() => new Request('http://127.0.0.1/', { method: 'GET', body: server.adapterBody('GET', body) })).not.toThrow();
    const req = new Request('http://127.0.0.1/', { method: 'GET', body: server.adapterBody('GET', body) });
    expect(req.body).toBeNull();
  });

  it('omits the body for HEAD', () => {
    const body = Buffer.from('hi');
    expect(() => new Request('http://127.0.0.1/', { method: 'HEAD', body: server.adapterBody('HEAD', body) })).not.toThrow();
    const req = new Request('http://127.0.0.1/', { method: 'HEAD', body: server.adapterBody('HEAD', body) });
    expect(req.body).toBeNull();
  });

  it('omits the body for a GET with no method header (defaults to GET)', () => {
    expect(server.adapterBody(undefined, Buffer.from('hi'))).toBeUndefined();
  });

  it('omits an empty body even for methods that accept one', () => {
    expect(server.adapterBody('POST', Buffer.alloc(0))).toBeUndefined();
  });

  it('keeps a non-empty body for POST', () => {
    const body = Buffer.from('{"draft":"x"}');
    const req = new Request('http://127.0.0.1/', { method: 'POST', body: server.adapterBody('POST', body) });
    expect(req.body).not.toBeNull();
  });
});

describe('parseAnnotations (#7: NaN/Infinity/negative/inverted offsets rejected)', () => {
  const valid = { start: 0, end: 5, fragment: 'abc', question: 'q?', ts: 1 };
  const withSource = { ...valid, source: 'seed' };

  it('returns null for a non-array payload (whole-request 400)', () => {
    expect(server.parseAnnotations({})).toBeNull();
    expect(server.parseAnnotations('nope')).toBeNull();
  });

  it('keeps well-formed annotations', () => {
    const out = server.parseAnnotations([valid, withSource]);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(2);
    expect(out![0]).toEqual(valid);
    expect(out![1]).toEqual(withSource);
  });

  it.each([
    ['NaN start', { ...valid, start: NaN }],
    ['Infinity end', { ...valid, end: Infinity }],
    ['-Infinity start', { ...valid, start: -Infinity }],
    ['negative start', { ...valid, start: -5 }],
    ['fractional start', { ...valid, start: 1.5 }],
    ['fractional end', { ...valid, end: 4.5 }],
    ['inverted range (end <= start)', { ...valid, start: 6, end: 5 }],
    ['zero span (end === start)', { ...valid, start: 5, end: 5 }],
  ])('skips an entry with %s', (_label, bad) => {
    const out = server.parseAnnotations([valid, bad]);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    expect(out![0]).toEqual(valid);
  });

  it('drops every entry when all are invalid, without failing the request', () => {
    expect(server.parseAnnotations([{ ...valid, start: NaN }])).toEqual([]);
  });
});
