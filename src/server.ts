/**
 * better-writer server: hosts the built client (`dist/`) and serves the wire
 * contract in src/types.ts (/ask, /save, /load, /transcribe) plus /health,
 * the client's probe for local-vs-static mode. Minimal Hono over node:http
 * with a hand-rolled adapter — no @hono/node-server dependency.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { GENRES, type Genre } from './types.js';
import { loadEnvFile } from './env.js';
import { makeComplete } from './llm.js';
import { pullSeed } from './seed.js';
import { reshape } from './reshape.js';
import { loadAnnotations, loadDraft, saveAnnotations, saveDraft } from './draft.js';
import { boundaryViolation } from './boundary.js';
import type { Annotation } from './types.js';
import { resolveModelDir } from './stt/model.js';
import { createSttClient } from './stt/client.js';

/** Built client, resolved from the module (not cwd). Vite outDir is ../dist. */
const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

// Populate the environment from .env BEFORE anything reads it: makeComplete
// snapshots BW_LLM_BASE_URL/BW_LLM_MODEL at construction. Real shell env vars
// always win (loadEnvFile never overwrites an existing key).
loadEnvFile();

const MIME: Record<string, string> = {
 '.html': 'text/html; charset=utf-8',
 '.js': 'text/javascript; charset=utf-8',
 '.mjs': 'text/javascript; charset=utf-8',
 '.css': 'text/css; charset=utf-8',
 '.json': 'application/json; charset=utf-8',
 '.svg': 'image/svg+xml',
 '.png': 'image/png',
 '.jpg': 'image/jpeg',
 '.jpeg': 'image/jpeg',
 '.gif': 'image/gif',
 '.ico': 'image/x-icon',
 '.webp': 'image/webp',
 '.woff': 'font/woff',
 '.woff2': 'font/woff2',
 '.ttf': 'font/ttf',
 '.map': 'application/json; charset=utf-8',
 '.txt': 'text/plain; charset=utf-8',
 '.webmanifest': 'application/manifest+json',
};

const LISTEN_ADDRESS = process.env.BW_HOST ?? '127.0.0.1';

/** Serializes draft/annotation IO so /load never observes a torn pair mid-/save. */
let ioChain: Promise<unknown> = Promise.resolve();
function ioSerial<T>(io: () => Promise<T>): Promise<T> {
  const run = ioChain.then(io, io);
  ioChain = run.then(() => undefined, () => undefined);
  return run;
}

const complete = makeComplete();
const app = new Hono();

// --- local-machine boundary (src/boundary.ts) ---

app.use('*', async (c, next) => {
  const violation = boundaryViolation(LISTEN_ADDRESS, c.req.header('host'), c.req.header('origin'));
  if (violation !== null) return c.json({ error: violation }, 403);
  await next();
});

// --- wire contract (src/types.ts) ---

/** Client's probe for local-vs-static mode: 200 means a local server is up. */
app.get('/health', (c) => c.json({ ok: true }));

app.post('/ask', async (c) => {
 const body = await c.req
  .json<{ text_window?: unknown; genre?: unknown }>()
  .catch(() => null);
 const textWindow = body?.text_window;
 const genre = body?.genre;
 if (typeof textWindow !== 'string') {
  return c.json({ error: 'text_window must be a string' }, 400);
 }
 if (typeof genre !== 'string' || !(GENRES as readonly string[]).includes(genre)) {
  return c.json({ error: `genre must be one of: ${GENRES.join(', ')}` }, 400);
 }
 try {
  const seed = await pullSeed(genre as Genre);
  const reshaped = await reshape(seed.question, textWindow, complete, (info) => {
   console.log(
    JSON.stringify({
     seed_id: seed.id,
     genre,
     failures: info.failures,
     fallback: info.fallback,
    }),
   );
  });
  // Spread both fields so the client can label the question's provenance.
  return c.json({ ...reshaped });
 } catch (err) {
  console.error('[server] /ask failed:', err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
 }
});

/** Validate an unknown value as an Annotation; null when it is not one. */
function parseAnnotation(value: unknown): Annotation | null {
 if (typeof value !== 'object' || value === null) return null;
 const a = value as Record<string, unknown>;
 if (typeof a.start !== 'number' || typeof a.end !== 'number') return null;
 if (typeof a.fragment !== 'string' || typeof a.question !== 'string') return null;
 if (typeof a.ts !== 'number') return null;
 // `source` is optional on persisted notes; pass it through only when it is
 // a genuine provenance label — an invalid value rejects the whole note
 // rather than stripping provenance silently on a /save round-trip.
 if (a.source !== undefined) {
  if (a.source !== 'seed' && a.source !== 'reshaped' && a.source !== 'topic-probe') return null;
  return { start: a.start, end: a.end, fragment: a.fragment, question: a.question, ts: a.ts, source: a.source };
 }
 return { start: a.start, end: a.end, fragment: a.fragment, question: a.question, ts: a.ts };
}

/** Validate an unknown value as an Annotation[]; null when it is not one. */
function parseAnnotations(value: unknown): Annotation[] | null {
 if (!Array.isArray(value)) return null;
 const out: Annotation[] = [];
 for (const item of value) {
  const parsed = parseAnnotation(item);
  if (parsed === null) return null;
  out.push(parsed);
 }
 return out;
}

app.post('/save', async (c) => {
 const body = await c.req
  .json<{ draft?: unknown; annotations?: unknown }>()
  .catch(() => null);
 const draft = body?.draft;
 if (typeof draft !== 'string') return c.json({ error: 'draft must be a string' }, 400);
 // Absent means the client dropped all notes: always overwrite, never leave stale ones.
 const annotations = body?.annotations === undefined ? [] : parseAnnotations(body.annotations);
 if (annotations === null) {
  return c.json({ error: 'annotations must be an array of {start, end, fragment, question, ts}' }, 400);
 }
 try {
  // Serialized so no /load can interleave between the draft and annotation writes.
  await ioSerial(async () => {
    await saveDraft(draft);
    await saveAnnotations(annotations);
  });
  return c.json({});
 } catch (err) {
  console.error('[server] /save failed:', err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
 }
});

app.get('/load', async (c) => {
 try {
  const state = await ioSerial(async () => {
    const draft = await loadDraft();
    return { draft, annotations: await loadAnnotations() };
  });
  return c.json(state);
 } catch (err) {
  console.error('[server] /load failed:', err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
 }
});

// --- STT (one-shot transcribe; the worker spawns lazily on first use) ---

let stt: ReturnType<typeof createSttClient> | null = null;
function sttClient(): ReturnType<typeof createSttClient> {
 stt ??= createSttClient();
 return stt;
}

app.post('/transcribe', async (c) => {
 const contentType = c.req.header('content-type') ?? '';
 if (!/audio\/(?:wav|x-wav|wave)/.test(contentType)) {
  return c.json({ error: 'expected Content-Type audio/wav' }, 400);
 }
 const bytes = new Uint8Array(await c.req.arrayBuffer());
 let samples: Float32Array;
 let sampleRate: number;
 try {
  ({ samples, sampleRate } = decodeWavPcm16(bytes));
 } catch (err) {
  return c.json({ error: `invalid WAV: ${err instanceof Error ? err.message : String(err)}` }, 400);
 }
 try {
  // Pre-spawn check so a missing model is a fast 503, not a worker crash.
  resolveModelDir();
  const result = await sttClient().transcribe(samples, sampleRate);
  return c.json({ text: result.text });
 } catch (err) {
  console.error('[server] /transcribe failed:', err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 503);
 }
});

// --- static hosting + SPA fallback (last; GET/HEAD only) ---

app.use('*', async (c, next) => {
 if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
 let pathname: string;
 try {
  pathname = decodeURIComponent(c.req.path);
 } catch {
  return c.text('bad request', 400);
 }
 const target = resolveWithin(DIST_DIR, pathname);
 if (target === null) return c.text('forbidden', 403);
 try {
  if (statSync(target).isFile()) {
   const data = await readFile(target);
   const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
   return c.body(data, 200, { 'content-type': type, 'content-length': String(data.length) });
  }
 } catch {
  // Fall through to the SPA fallback.
 }
 try {
  const data = await readFile(join(DIST_DIR, 'index.html'));
  return c.body(data, 200, {
   'content-type': 'text/html; charset=utf-8',
   'content-length': String(data.length),
  });
 } catch {
  return c.text('not found', 404);
 }
});

/** Resolve a request path inside the dist root, or null if it escapes it. */
function resolveWithin(root: string, pathname: string): string | null {
 const rel = pathname.replace(/^\/+/, '');
 const target = normalize(join(root, rel === '' ? 'index.html' : rel));
 if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
  return null;
 }
 return target;
}

/** Decode a PCM16 mono WAV payload into samples for the STT worker. */
function decodeWavPcm16(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
 if (bytes.length < 44) throw new Error('too short for a WAV header');
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WAVE') {
  throw new Error('not a RIFF/WAVE file');
 }
 let offset = 12;
 let audioFormat = 0;
 let channels = 0;
 let sampleRate = 0;
 let bitsPerSample = 0;
 let dataOffset = -1;
 let dataSize = 0;
 while (offset + 8 <= bytes.length) {
  const id = ascii(bytes, offset, offset + 4);
  const size = view.getUint32(offset + 4, true);
  if (id === 'fmt ') {
   audioFormat = view.getUint16(offset + 8, true);
   channels = view.getUint16(offset + 10, true);
   sampleRate = view.getUint32(offset + 12, true);
   bitsPerSample = view.getUint16(offset + 22, true);
  } else if (id === 'data') {
   dataOffset = offset + 8;
   dataSize = size;
   break;
  }
  // Chunks are word-aligned; clamp the skip so corrupt sizes cannot loop.
  const skip = Math.min(size, bytes.length - (offset + 8));
  offset += 8 + skip + (skip % 2);
 }
 if (dataOffset < 0) throw new Error('no data chunk');
 if (audioFormat !== 1) throw new Error(`unsupported audio format ${audioFormat} (expected PCM)`);
 if (channels !== 1) throw new Error(`expected mono, got ${channels} channel(s)`);
 if (bitsPerSample !== 16) throw new Error(`expected 16-bit PCM, got ${bitsPerSample}`);
 const count = Math.min(dataSize, bytes.length - dataOffset) >> 1;
 const samples = new Float32Array(count);
 for (let i = 0; i < count; i++) {
  samples[i] = view.getInt16(dataOffset + i * 2, true) / 32768;
 }
 return { samples, sampleRate };
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
 let s = '';
 for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]);
 return s;
}

// --- node:http adapter for Hono's fetch handler ---

const server = createServer((req, res) => {
 void handle(app, req, res).catch((err) => {
  console.error('[server] request failed:', err);
  if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'internal server error' }));
 });
});

async function handle(app: Hono, req: IncomingMessage, res: ServerResponse): Promise<void> {
 const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
 const chunks: Buffer[] = [];
 for await (const chunk of req) chunks.push(chunk as Buffer);
 const body = Buffer.concat(chunks);
 // IncomingHttpHeaders is not exactly HeadersInit, but undici accepts it.
 const headers = req.headers as unknown as HeadersInit;
 const request = new Request(url, {
  method: req.method ?? 'GET',
  headers,
  body: body.length > 0 ? body : undefined,
 });
 const response = await app.fetch(request);
 const responseHeaders: Record<string, string> = {};
 response.headers.forEach((value, key) => {
  responseHeaders[key] = value;
 });
 res.writeHead(response.status, responseHeaders);
 if (response.body === null) {
  res.end();
  return;
 }
 // The DOM and node:stream/web ReadableStream types are structurally
 // identical; the cast only unifies them for Readable.fromWeb.
 const bodyStream = response.body as import('node:stream/web').ReadableStream<Uint8Array>;
 await new Promise<void>((resolve, reject) => {
  Readable.fromWeb(bodyStream)
   .pipe(res)
   .on('finish', () => resolve())
   .on('error', reject);
 });
}

// --- boot ---

const rawPort = process.env.BW_PORT;
const port = Number(rawPort ?? '4517');
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
 throw new Error(`invalid BW_PORT: ${JSON.stringify(rawPort)}`);
}
server.listen(port, LISTEN_ADDRESS, () => {
 console.log(`better-writer server: http://${LISTEN_ADDRESS}:${port} (static: ${DIST_DIR})`);
});
