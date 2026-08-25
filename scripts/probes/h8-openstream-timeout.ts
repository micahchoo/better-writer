/**
 * h8-openstream-timeout.ts — STT client asymmetry: transcribe() arms a 120s
 * hung-worker timeout (S3-10), openStream() does not. If the worker never
 * answers stream-ready (e.g. model load hangs), openStream()'s `ready.promise`
 * has no deadline — it settles only on stream-ready or on worker exit/error.
 * A worker stuck in model load is exactly the case transcribe() guards against,
 * and openStream() is the same spawn path with no guard.
 *
 * Repro: a real createSttClient against a fake worker process that reads stdin
 * but never answers stream-open (alive-but-hung). Measure how long openStream
 * stays pending.
 */
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSttClient } from '../../src/stt/client';

const dir = mkdtempSync(join(tmpdir(), 'h8-stt-'));
// Fake worker: reads lines, never answers stream-open (simulates alive-but-
// stuck-in-model-load), exits on shutdown.
writeFileSync(join(dir, 'fake-worker.mjs'), `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m.type === 'shutdown') process.exit(0); } catch {}
});
setInterval(() => {}, 1000);
`);

try {
  const client = createSttClient({
    tsxPath: process.execPath, // node
    workerPath: join(dir, 'fake-worker.mjs'),
  });

  console.log('openStream against a worker that never answers stream-ready...');
  const openPromise = client.openStream!();

  const settled = await Promise.race([
    openPromise.then(() => 'settled'),
    new Promise<string>((res) => setTimeout(() => res('STILL PENDING after 3s'), 3000)),
  ]);
  console.log('openStream() after 3s :', settled);
  console.log('  -> no deadline is armed (transcribe has TRANSCRIBE_TIMEOUT_MS=120s + SIGKILL; openStream has neither)');

  client.dispose();
  const settled2 = await Promise.race([
    openPromise.then(() => 'settled').catch((e) => `rejected: ${(e as Error).message.slice(0, 50)}`),
    new Promise<string>((res) => setTimeout(() => res('STILL PENDING after dispose'), 2000)),
  ]);
  console.log('after dispose()       :', settled2);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
