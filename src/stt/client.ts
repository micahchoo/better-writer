/**
 * Parent-side STT client. Spawns a child process running the sherpa-onnx
 * worker, sends audio over stdio, and returns transcriptions.
 *
 * Lazy spawn — the process starts on the first `transcribe()` or
 * `openStream()` call. `dispose()` hard-kills the child so the native
 * addon's destructor never runs in a shared address space
 * (sherpa-onnx-node's NAPI finalizer can segfault on shutdown).
 *
 * Streaming (redesign wave 4): `openStream()` opens a transcription
 * session whose id is correlated over the same stdio pipe. `pushAudio`
 * is fire-and-forget (the worker processes messages in order and answers
 * partials asynchronously); `end()` resolves when the final partial lands.
 * The one-shot `transcribe()` path is unchanged.
 *
 * Robustness (bug-hunt #15/#16/#17, S3-8..S3-12):
 * - `end()` on an already-failed stream settles immediately with the recorded
 *   error instead of writing into a dead id and hanging forever (#15).
 * - `end()` returns only what the wire actually carries — text — plus timing
 *   arrays documented as never populated until the protocol supports them (#16).
 * - The worker path is resolved with `fileURLToPath`, so a repo path containing
 *   spaces or non-ASCII chars is not percent-encoded into the spawn arg (#17/S3-9).
 * - A dead stdin (EPIPE after a worker crash) settles everything in flight as a
 *   transport failure instead of raising an unhandled 'error' that kills the
 *   whole server; `transcribe()` also has a timeout so a hung worker cannot
 *   leave the request pending forever (S3-10), and `openStream()` has the same
 *   deadline on its stream-ready wait (H8-1).
 * - `dispose()` is idempotent and settles outstanding work, ready for the
 *   server's future SIGINT/SIGTERM hook.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Outbound } from './protocol.js';
import { resolveModelDir } from './model.js';

// --- protocol: one shared contract (src/stt/protocol.ts) ---

/** Result of a transcription: transcript plus per-token timing from the worker. */
export interface SttTranscriptionResult {
 text: string;
 tokens: string[];
 timestamps: number[];
 durations: number[];
}

/** One streaming hypothesis: the cumulative text, final on stream-end. */
export interface SttStreamPartial {
 text: string;
 final: boolean;
}

/**
 * Final result of a streaming session. Only `text` is populated today: the
 * final partial carries text alone over the wire (`PartialResp`), so the
 * timing arrays are reserved and never populated until the protocol sends
 * them. They are optional to make that absence visible instead of fabricating
 * empty arrays behind a type that promised per-token data (#16).
 */
export interface SttStreamFinal {
 text: string;
 tokens?: string[];
 timestamps?: number[];
 durations?: number[];
}

/** A live streaming transcription session, correlated by `streamId`. */
export interface SttStream {
 streamId: string;
 /** Push one chunk of audio; fire-and-forget (partials arrive via onPartial). */
 pushAudio(samples: Float32Array, sampleRate: number): void;
 /** Finalize the stream; resolves with the final transcript (text-only today). */
 end(): Promise<SttStreamFinal>;
 /** Subscribe to partial hypotheses. Returns an unsubscribe function. */
 onPartial(cb: (partial: SttStreamPartial) => void): () => void;
 /** Subscribe to stream-scoped failures. Returns an unsubscribe function. */
 onError(cb: (err: Error) => void): () => void;
}

interface Deferred<T> {
 resolve: (value: T) => void;
 reject: (err: Error) => void;
 promise: Promise<T>;
}

function deferred<T>(): Deferred<T> {
 let resolve!: (value: T) => void;
 let reject!: (err: Error) => void;
 const promise = new Promise<T>((res, rej) => {
  resolve = res;
  reject = rej;
 });
 return { resolve, reject, promise };
}


type WorkerMsg = Outbound;
// --- client ---

export interface SttClient {
 /**
  * Transcribe 16 kHz mono audio. Spawns the worker on first call.
  * Rejects on worker error or spawn failure.
  */
 transcribe(
  samples: Float32Array,
  sampleRate: number,
 ): Promise<SttTranscriptionResult>;

 /**
  * Open a streaming transcription session. Resolves once the worker has
  * loaded the recognizer and created the stream; rejects on worker error
  * or spawn failure. Absent on a client that does not support streaming.
  */
 openStream?(): Promise<SttStream>;

 /** Kill the worker process. Safe to call multiple times. */
 dispose(): void;
}

export interface SttClientOptions {
 /** Override the tsx path used to spawn the worker. */
 tsxPath?: string;
 /** Override the worker script path. */
 workerPath?: string;
}

interface StreamState {
 id: string;
 ready: Deferred<void>;
 pendingEnd: Deferred<SttStreamFinal> | null;
 /** Set when the stream has terminally failed; a later end() rejects with it. */
 failed: Error | null;
 /** Resolved final transcript, set once the stream ends successfully. */
 finalResult: SttStreamFinal | null;
 partialCbs: Set<(partial: SttStreamPartial) => void>;
 errorCbs: Set<(err: Error) => void>;
}

/**
 * How long a one-shot `transcribe()` waits before declaring the worker hung
 * and settling the request as a transport failure. The budget is sized well
 * above normal latency — the worker cold-loads a 0.6B int8 Parakeet TDT model
 * on CPU with 4 threads on first spawn, which can take tens of seconds — while
 * still bounding a worker whose model load never completes (which would
 * otherwise leave the request, and the server's /transcribe handler, pending
 * forever). 120s is far past the slowest legitimate first decode yet far below
 * an unbounded hang.
 */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

/**
 * Deadline for the worker to answer `stream-open`. Shorter than the transcribe
 * deadline because nothing is being decoded yet — the worker only has to
 * acknowledge the session. `transcribe()` has had a deadline since S3-10;
 * `openStream()` awaited `ready` with none at all, so a live-but-stuck worker
 * left the caller pending until dispose() (H8-1).
 */
const STREAM_OPEN_TIMEOUT_MS = 30_000;

export function createSttClient(opts?: SttClientOptions): SttClient {
 const tsxPath = opts?.tsxPath ?? 'npx';
 const workerPath = opts?.workerPath
  ?? fileURLToPath(new URL('./worker.ts', import.meta.url));

 // When using npx, prepend 'tsx' as the subcommand argument.
 const spawnCmd = tsxPath;
 const spawnArgs = tsxPath === 'npx' ? ['tsx', workerPath] : [workerPath];

 let child: ChildProcess | null = null;
 let disposed = false;
 let nextId = 0;
 const pending = new Map<string, Deferred<SttTranscriptionResult>>();
 const streams = new Map<string, StreamState>();
 let leftover = '';

 /** Settle every in-flight one-shot and stream with `err` (transport failure). */
 function failOutstanding(err: Error): void {
  for (const [id, dfd] of pending) {
   dfd.reject(err);
   pending.delete(id);
  }
  for (const [id, st] of streams) {
   st.failed = err;
   st.ready.reject(err);
   for (const cb of st.errorCbs) cb(err);
   if (st.pendingEnd) {
    st.pendingEnd.reject(err);
    st.pendingEnd = null;
   }
   streams.delete(id);
  }
 }

 function ensureSpawned(): ChildProcess {
  if (child && !child.killed && !disposed) return child;

  // A request arriving after dispose() (or a worker crash) wants a live
  // worker — clear the dispose latch and spawn fresh. The old process (if
  // any) is already being torn down by its own SIGKILL timer / exit path,
  // and the stale-guards below stop it from clobbering the new child.
  disposed = false;

  const modelDir = resolveModelDir();

  const proc = spawn(spawnCmd, spawnArgs, {
   env: { ...process.env, BW_STT_MODEL_DIR: modelDir },
   stdio: ['pipe', 'pipe', 'inherit'],
  });
  child = proc;

  proc.stdout!.on('data', (chunk: Buffer) => {
   leftover += chunk.toString('utf-8');
   const lines = leftover.split('\n');
   // The last element may be incomplete — keep it for the next chunk.
   leftover = lines.pop() ?? '';

   for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: WorkerMsg;
    try {
     msg = JSON.parse(trimmed) as WorkerMsg;
    } catch {
     // Malformed line — log and skip. The pending promise
     // will eventually be rejected by the 'exit' handler.
     console.error('[stt-client] invalid worker message:', trimmed);
     continue;
    }

    if (msg.type === 'stream-ready') {
     const st = streams.get(msg.id);
     if (st) st.ready.resolve();
     continue;
    }

    if (msg.type === 'partial') {
     const st = streams.get(msg.id);
     if (!st) continue;
     const partial: SttStreamPartial = { text: msg.text, final: msg.final === true };
     for (const cb of st.partialCbs) cb(partial);
     if (partial.final && st.pendingEnd) {
      const result: SttStreamFinal = { text: msg.text };
      st.finalResult = result;
      st.pendingEnd.resolve(result);
      st.pendingEnd = null;
      streams.delete(msg.id);
     }
     continue;
    }

    if (msg.type === 'stream-error') {
     const st = streams.get(msg.id);
     if (!st) continue;
     const err = new Error(msg.error);
     st.failed = err;
     st.ready.reject(err);
     for (const cb of st.errorCbs) cb(err);
     if (st.pendingEnd) {
      st.pendingEnd.reject(err);
      st.pendingEnd = null;
     }
     streams.delete(msg.id);
     continue;
    }

    const dfd = pending.get(msg.id);
    if (!dfd) continue;

    pending.delete(msg.id);

    if (msg.type === 'transcription') {
     dfd.resolve({
      text: msg.text,
      tokens: msg.tokens,
      timestamps: msg.timestamps,
      durations: msg.durations,
     });
    } else if (msg.type === 'error') {
     dfd.reject(new Error(msg.error));
    }
   }
  });

  proc.on('exit', (code, signal) => {
   if (child !== proc) return; // superseded by a fresh spawn
   const reason = signal
    ? `worker killed by signal ${signal}`
    : `worker exited with code ${code}`;
   failOutstanding(new Error(reason));
   child = null;
  });

  proc.on('error', (err) => {
   if (child !== proc) return;
   failOutstanding(err);
   child = null;
  });

  // S3-10: a write to a dead pipe (EPIPE after a sherpa segfault) would
  // otherwise surface as an unhandled 'error' event that takes the whole
  // server process down. Treat it as a transport failure and settle
  // everything in flight, then forget the dead child so the next request
  // spawns fresh.
  proc.stdin!.on('error', (err) => {
   if (child !== proc) return;
   failOutstanding(new Error(`worker stdin failed: ${err.message}`));
   child = null;
  });

  return proc;
 }

 function float32ToBase64(samples: Float32Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
 }

 function sendInbound(msg: string): void {
  const proc = ensureSpawned();
  try {
   proc.stdin!.write(`${msg}\n`);
  } catch {
   // stdin destroyed (worker already gone); the 'error'/'exit' handlers
   // settle whatever is in flight.
  }
 }

 return {
  async transcribe(
   samples: Float32Array,
   sampleRate: number,
  ): Promise<SttTranscriptionResult> {
   const id = String(nextId++);
   const dfd = deferred<SttTranscriptionResult>();
   pending.set(id, dfd);

   sendInbound(JSON.stringify({
    type: 'transcribe',
    id,
    samples: float32ToBase64(samples),
    sampleRate,
   }));

   // S3-10: a worker whose model load never completes would otherwise leave
   // this promise — and the server's /transcribe handler — pending forever.
   const timer = setTimeout(() => {
    const err = new Error(
     `transcribe timed out after ${TRANSCRIBE_TIMEOUT_MS / 1000}s — worker presumed hung`,
    );
    // The worker is hung: tear it down so the next call spawns fresh. The
    // exit handler also settles any streams / other in-flight requests.
    if (child && !child.killed) {
     try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    const live = pending.get(id);
    if (live) {
     live.reject(err);
     pending.delete(id);
    }
   }, TRANSCRIBE_TIMEOUT_MS);
   timer.unref();

   try {
    return await dfd.promise;
   } finally {
    clearTimeout(timer);
   }
  },

  async openStream(): Promise<SttStream> {
   const id = `s-${nextId++}`;
   const ready = deferred<void>();
   const state: StreamState = {
    id,
    ready,
    pendingEnd: null,
    failed: null,
    finalResult: null,
    partialCbs: new Set(),
    errorCbs: new Set(),
   };
   streams.set(id, state);

   sendInbound(JSON.stringify({ type: 'stream-open', id }));

   // H8-1: bound the wait for stream-ready. A worker that spawned but never
   // answers is indistinguishable from a slow one, so treat it exactly as
   // transcribe() does — reject, tear the worker down so the next call spawns
   // fresh, and let the exit handler settle everything else in flight.
   const openTimer = setTimeout(() => {
    const err = new Error(
     `stream-open timed out after ${STREAM_OPEN_TIMEOUT_MS / 1000}s — worker presumed hung`,
    );
    const live = streams.get(id);
    if (live) {
     live.failed = err;
     live.ready.reject(err);
     for (const cb of live.errorCbs) cb(err);
     streams.delete(id);
    }
    if (child && !child.killed) {
     try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
   }, STREAM_OPEN_TIMEOUT_MS);
   openTimer.unref();

   try {
    await ready.promise;
   } finally {
    clearTimeout(openTimer);
   }

   return {
    streamId: id,
    pushAudio(samples: Float32Array, sampleRate: number): void {
     sendInbound(JSON.stringify({
      type: 'audio',
      id,
      samples: float32ToBase64(samples),
      sampleRate,
     }));
    },
    end(): Promise<SttStreamFinal> {
     // #15: a stream that has already failed must settle immediately with
     // the recorded error, not write into a dead id and hang forever.
     if (state.failed) return Promise.reject(state.failed);
     if (state.finalResult) return Promise.resolve(state.finalResult);
     if (state.pendingEnd) return state.pendingEnd.promise;
     state.pendingEnd = deferred<SttStreamFinal>();
     sendInbound(JSON.stringify({ type: 'stream-end', id }));
     return state.pendingEnd.promise;
    },
    onPartial(cb: (partial: SttStreamPartial) => void): () => void {
     state.partialCbs.add(cb);
     return () => { state.partialCbs.delete(cb); };
    },
    onError(cb: (err: Error) => void): () => void {
     state.errorCbs.add(cb);
     return () => { state.errorCbs.delete(cb); };
    },
   };
  },

  dispose(): void {
   if (disposed) return; // idempotent
   disposed = true;
   const proc = child;
   if (proc && !proc.killed) {
    // Try graceful shutdown first, then hard-kill.
    try {
     proc.stdin!.write('{"type":"shutdown"}\n');
    } catch {
     // stdin may already be closed.
    }
    setTimeout(() => {
     if (!proc.killed) {
      proc.kill('SIGKILL');
     }
    }, 1000).unref();
   }
   // Settle anything still in flight — the process is going away.
   failOutstanding(new Error('stt client disposed'));
  },
 };
}
