/**
 * better-writer server: hosts the built client (`dist/`) and serves the wire
 * contract in src/types.ts (/ask, /save, /load, /transcribe) plus /health,
 * the client's probe for local-vs-static mode. Minimal Hono over node:http
 * with a hand-rolled adapter — no @hono/node-server dependency.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { Hono } from 'hono';
import { GENRES, type Genre } from './core/types.js';
import { loadEnvFile } from './env.js';
import { makeComplete } from './llm.js';
import { loadSeeds, drawCandidates } from './core/seeds.js';
import { askFromCandidates } from './core/agent.js';
import { parseCoachInput } from './core/contract.js';
import { loadAnnotations, loadDraft, saveAnnotations, saveDraft } from './draft.js';
import { boundaryViolation } from './boundary.js';
import type { Annotation } from './core/types.js';
import { resolveModelDir } from './stt/model.js';
import { createSttClient } from './stt/client.js';
import type { SttClient } from './stt/client.js';

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

/** Port to listen on and the only Origin authority this machine trusts. */
const rawPort = process.env.BW_PORT;
const port = Number(rawPort ?? '4517');
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`invalid BW_PORT: ${JSON.stringify(rawPort)}`);
}

/** Serializes draft/annotation IO so /load never observes a torn pair mid-/save. */
let ioChain: Promise<unknown> = Promise.resolve();
function ioSerial<T>(io: () => Promise<T>): Promise<T> {
  const run = ioChain.then(io, io);
  ioChain = run.then(() => undefined, () => undefined);
  return run;
}

const complete = makeComplete();
export const app = new Hono();

// --- local-machine boundary (src/boundary.ts) ---

app.use('*', async (c, next) => {
  const violation = boundaryViolation(LISTEN_ADDRESS, port, c.req.header('host'), c.req.header('origin'));
  if (violation !== null) return c.json({ error: violation }, 403);
  await next();
});

// --- wire contract (src/types.ts) ---

/**
 * Log the real failure, tell the client nothing about our internals.
 *
 * `/ask`, `/save` and `/load` used to return `err.message` verbatim, so a seed
 * pull failure answered with retrieve.py's stderr and filesystem paths while
 * `/transcribe` — the other guarded route — deliberately returned a generic
 * 503. The two disagreed about disclosure and the coach endpoint was the one
 * leaking (H4-3). The server console keeps the detail; the writer gets a
 * sentence they can act on.
 */
function internalError(route: string, err: unknown, message: string): { error: string } {
  console.error(`[server] ${route} failed:`, err);
  return { error: message };
}

/** Client's probe for local-vs-static mode: 200 means a local server is up. */
app.get('/health', (c) => c.json({ ok: true }));

app.post('/ask', async (c) => {
  const input = parseCoachInput(await c.req.json().catch(() => null));
  if (!input) return c.json({ error: 'invalid coaching window, focus, position, or genre' }, 400);
  const signal = c.req.raw.signal;
  try {
    signal.throwIfAborted();
    const candidates = drawCandidates(await loadSeeds(), input);
    signal.throwIfAborted();
    const result = await askFromCandidates(input, candidates.map(seed => seed.question), complete, signal);
    return c.json(result);
  } catch (err) {
    if (signal.aborted) return c.json({ kind: 'unavailable', retryable: false }, 408);
    internalError('/ask', err, 'the coach could not answer');
    return c.json({ kind: 'unavailable', retryable: true }, 503);
  }
});

export function parseAnnotation(value: unknown): Annotation | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  if (typeof a.start !== 'number' || typeof a.end !== 'number') return null;
  if (typeof a.fragment !== 'string' || typeof a.question !== 'string') return null;
  if (typeof a.ts !== 'number') return null;
  // Offsets must be finite integers with a positive, non-degenerate span. A
  // NaN/Infinity/negative/inverted pair would corrupt the persisted set, so
  // reject it at the door rather than letting it ride through to /load.
  if (
    !Number.isFinite(a.start) ||
    !Number.isFinite(a.end) ||
    !Number.isInteger(a.start) ||
    !Number.isInteger(a.end) ||
    a.start < 0 ||
    a.end <= a.start
  ) {
    return null;
  }
  // `source` is optional on persisted notes; pass it through only when it is
  // a genuine provenance label — an invalid value rejects the whole note
  // rather than stripping provenance silently on a /save round-trip.
  if (a.source !== undefined) {
    if (a.source !== 'seed' && a.source !== 'reshaped' && a.source !== 'topic-probe') return null;
    // Source is copied below with the other optional annotation fields.
  }
  const out: Annotation = {
    start: a.start,
    end: a.end,
    fragment: a.fragment,
    question: a.question,
    ts: a.ts,
  };
  if (typeof a.id === 'string' && a.id.length > 0) out.id = a.id;
  if (a.source === 'seed' || a.source === 'reshaped' || a.source === 'topic-probe') out.source = a.source;
  const ctx = a.context;
  if (typeof ctx === 'object' && ctx !== null) {
    const { before, after } = ctx as Record<string, unknown>;
    // Carried through, never trusted: context only disambiguates duplicates
    // (H9-1), so a malformed value is dropped rather than failing the note.
    if (typeof before === 'string' && typeof after === 'string') out.context = { before, after };
  }
  return out;
}

/** Validate an unknown value as an Annotation[]; null when it is not one. */
export function parseAnnotations(value: unknown): Annotation[] | null {
  if (!Array.isArray(value)) return null;
  const out: Annotation[] = [];
  for (const item of value) {
    const parsed = parseAnnotation(item);
    // Skip malformed entries rather than failing the whole request: one bad
    // offset must not nuke the rest of the writer's saved notes.
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

app.post('/save', async (c) => {
 const raw = await c.req.text();
 let body: { draft?: unknown; annotations?: unknown };
 try {
  body = JSON.parse(raw) as { draft?: unknown; annotations?: unknown };
 } catch {
  // Distinguish a malformed body from a valid object with a wrong-typed
  // field: 'not json' must not masquerade as a draft validation failure.
  return c.json({ error: 'invalid JSON body' }, 400);
 }
 if (body === null || typeof body !== 'object') {
  return c.json({ error: 'request body must be a JSON object' }, 400);
 }
 const draft = body.draft;
 if (typeof draft !== 'string') return c.json({ error: 'draft must be a string' }, 400);
 // Absent means the client dropped all notes: always overwrite, never leave stale ones.
 const annotations = body.annotations === undefined ? [] : parseAnnotations(body.annotations);
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
  return c.json(internalError('/save', err, 'the draft could not be saved — see the server log'), 500);
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
  return c.json(internalError('/load', err, 'the draft could not be loaded — see the server log'), 500);
 }
});

// --- STT (one-shot transcribe; the worker spawns lazily on first use) ---

/**
 * A /transcribe payload shorter than this (measured at the WAV's own sample
 * rate) is noise, not speech. Rejecting it before the worker keeps a
 * near-empty WAV from ever reaching ONNX, which would surface a raw
 * ConvInteger status as a client toast instead of a plain-language 400.
 */
const MIN_RECORDING_SECONDS = 0.1;

let stt: SttClient | null = null;

app.post('/transcribe', async (c) => {
 const contentType = c.req.header('content-type') ?? '';
 // Anchor to the media type before parameters: 'text/plain; charset=audio/wave'
 // must not pass, and `\b` stops audio/wav from matching audio/wave forms.
 const mediaType = contentType.split(';')[0].trim().toLowerCase();
 if (!/^audio\/(?:wav|x-wav|wave)\b/.test(mediaType)) {
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
 // Bad input (a sub-100ms payload) is a 400, not a 503: it never reaches the
 // worker, so the client gets a plain-language message rather than raw ONNX.
 if (sampleRate <= 0 || samples.length / sampleRate < MIN_RECORDING_SECONDS) {
  return c.json({ error: 'recording too short — record a moment of speech before transcribing' }, 400);
 }
 try {
  // Pre-spawn check so a missing model is a fast 503, not a worker crash.
  resolveModelDir();
  const result = await (stt ??= createSttClient()).transcribe(samples, sampleRate);
  return c.json({ text: result.text });
 } catch (err) {
  console.error('[server] /transcribe failed:', err);
  // A missing or failed recognizer is genuinely unavailable; keep the writer
  // on plain language instead of raw ONNX internals.
  return c.json({ error: 'transcription failed — the local speech model could not process this audio' }, 503);
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

/**
 * Body for a client's request as an undici Request body. GET and HEAD must
 * never carry one — undici throws `TypeError: Request with GET/HEAD method
 * cannot have body`, which would 500 a harmless probe. Empty bodies are
 * omitted too.
 */
export function adapterBody(method: string | undefined, body: Buffer): BodyInit | undefined {
  const m = method ?? 'GET';
  if (m === 'GET' || m === 'HEAD' || body.length === 0) return undefined;
  return body as unknown as BodyInit;
}

const server = createServer((req, res) => {
  void handle(app, req, res).catch((err) => {
    console.error('[server] request failed:', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal server error' }));
  });
});

/**
 * Largest request body the server will buffer. `/save` reads the whole body
 * into memory and writes it to disk, so without a cap one request could
 * exhaust memory and fill the disk — a 50 MB draft was accepted and written
 * (H4-2). The boundary's own premise is that other local processes are
 * hostile to `/save`, which makes this the same threat model.
 *
 * 5 MB is far above any real draft (the sample is ~2 KB) and far below a
 * problem.
 */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * A Host header safe to build a URL from: a bracketed IPv6 literal or a
 * hostname, each with an optional numeric port. `handle` builds a URL from
 * the UNTRUSTED Host before Hono runs, so a malformed value threw inside the
 * adapter and surfaced as a generic 500 — the documented fail-closed 403 was
 * unreachable for exactly the inputs it exists to reject (H4-1).
 */
export const SAFE_HOST_RE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

function endJson(res: ServerResponse, status: number, payload: unknown): void {
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handle(app: Hono, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Validate Host BEFORE it reaches the URL constructor, so a malformed value
  // fails closed with the boundary's own 403 rather than crashing the adapter.
  const rawHost = req.headers.host;
  if (rawHost !== undefined && !SAFE_HOST_RE.test(rawHost)) {
    endJson(res, 403, { error: `untrusted Host "${rawHost}"` });
    req.resume();
    return;
  }
  const url = new URL(req.url ?? '/', `http://${rawHost ?? '127.0.0.1'}`);
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    endJson(res, 413, { error: 'request body too large' });
    req.resume();
    return;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    received += buf.length;
    // Enforce on RECEIVED bytes too: Content-Length can lie or be absent
    // (chunked transfer). Stop reading as soon as the cap is passed.
    if (received > MAX_BODY_BYTES) {
      endJson(res, 413, { error: 'request body too large' });
      req.destroy();
      return;
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);
  // IncomingHttpHeaders is not exactly HeadersInit, but undici accepts it.
  const headers = req.headers as unknown as HeadersInit;
  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abort);
  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers,
    body: adapterBody(req.method, body),
    signal: controller.signal,
  });
  const response = await app.fetch(request);
  if (controller.signal.aborted) return;
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
  const bodyStream = response.body as NodeWebReadableStream<Uint8Array>;
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(bodyStream)
      .pipe(res)
      .on('finish', () => resolve())
      .on('error', reject);
  });
}

// --- shutdown: dispose the STT worker so its native model never orphans ---

/** Minimal process surface registerShutdownHandlers drives; injectable for tests. */
export interface ShutdownTarget {
  on(event: string, handler: () => void): unknown;
  exit(code?: number): void;
}

/**
 * SIGINT/SIGTERM shutdown: dispose the STT worker (so its native Parakeet
 * addon never lingers orphaned after a kill) then exit with a normal status.
 * The first signal wins — a second one is ignored, so dispose() runs exactly
 * once and exit() fires once. Accepts a process-like shim so tests can drive
 * both signals without a real process.
 */
export function registerShutdownHandlers(proc: ShutdownTarget, dispose: () => void): void {
  let shuttingDown = false;
  const handler = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      dispose();
    } finally {
      proc.exit(0);
    }
  };
  proc.on('SIGINT', handler);
  proc.on('SIGTERM', handler);
}

/** Importing routes opens no sockets; only the executable starts listening. */
export function startServer() {
  registerShutdownHandlers(process, () => { stt?.dispose(); server.close(); });
  return server.listen(port, LISTEN_ADDRESS, () => {
    console.log(`better-writer server: http://${LISTEN_ADDRESS}:${port} (static: ${DIST_DIR})`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer();
