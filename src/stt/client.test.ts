import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createSttClient } from './client';

// --- hoisted mocks: the client spawns a real sherpa worker; tests inject a
// fake child and a fake model dir instead. ---
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('./model.js', () => ({ resolveModelDir: () => '/tmp/fake-model' }));

interface FakeChild {
 child: {
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  stdin: { write: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  stdout: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
 };
 emitStdout(msg: unknown): void;
 emit(ev: string, ...args: unknown[]): void;
}

function makeFakeChild(): FakeChild {
 const dataHandlers: Array<(chunk: string) => void> = [];
 const eventHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};
 const stdinErrorHandlers: Array<(e: Error) => void> = [];
 const stdin = {
  write: vi.fn(() => true),
  on: vi.fn((ev: string, cb: (e: Error) => void) => {
   if (ev === 'error') stdinErrorHandlers.push(cb);
  }),
 };
 const child: FakeChild['child'] = {
  killed: false,
  kill: vi.fn(() => {
   child.killed = true;
   return true;
  }),
  stdin,
  stdout: { on: vi.fn((ev: string, cb: (c: string) => void) => { if (ev === 'data') dataHandlers.push(cb); }) },
  on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
   (eventHandlers[ev] ??= []).push(cb);
  }),
 };
 return {
  child,
  emitStdout(msg: unknown) {
   for (const h of dataHandlers) h(JSON.stringify(msg) + '\n');
  },
  emit(ev: string, ...args: unknown[]) {
   for (const h of eventHandlers[ev] ?? []) h(...args);
  },
 };
}

beforeEach(() => {
 spawnMock.mockReset();
});

/** Fire a transcribe without awaiting it; a dispose() later settles it. */
function fireTranscribe(client: ReturnType<typeof createSttClient>): void {
 client.transcribe(new Float32Array(4), 16000).catch(() => {
  /* expected: dispose settles outstanding work */
 });
}

describe('SttStream.end()', () => {
 it('#15 rejects (does not hang) after a stream-error, with no onError subscription', async () => {
  const client = createSttClient();
  const fake = makeFakeChild();
  spawnMock.mockReturnValue(fake.child);

  const streamPromise = client.openStream!();
  fake.emitStdout({ type: 'stream-ready', id: 's-0' });
  const stream = await streamPromise;

  fake.emitStdout({ type: 'stream-error', id: 's-0', error: 'decode exploded' });

  await expect(stream.end()).rejects.toThrow('decode exploded');
 });

 it('#16 resolves with text only on the final partial (no fabricated timings)', async () => {
  const client = createSttClient();
  const fake = makeFakeChild();
  spawnMock.mockReturnValue(fake.child);

  const streamPromise = client.openStream!();
  fake.emitStdout({ type: 'stream-ready', id: 's-0' });
  const stream = await streamPromise;

  const pending = stream.end();
  fake.emitStdout({ type: 'partial', id: 's-0', text: 'hello world', final: true });

  await expect(pending).resolves.toEqual({ text: 'hello world' });
 });
});

describe('transcribe() timeout', () => {
 it('S3-10 settles as a transport timeout against a never-responding worker and SIGKILLs it', async () => {
  vi.useFakeTimers();
  try {
   const client = createSttClient();
   const fake = makeFakeChild();
   spawnMock.mockReturnValue(fake.child);

   const pending = client.transcribe(new Float32Array(4), 16000);
   vi.advanceTimersByTime(120_001);

   await expect(pending).rejects.toThrow('timed out');
   expect(fake.child.kill).toHaveBeenCalledWith('SIGKILL');
  } finally {
   vi.useRealTimers();
  }
 });
});

describe('worker path', () => {
 it('#17/S3-9 fileURLToPath decodes spaces that URL.pathname would percent-encode', () => {
  const withSpace = new URL('file:///home/user/better%20writer/src/stt/worker.ts');
  const viaPathname = withSpace.pathname; // '/home/user/better%20writer/...'
  const viaFileURL = fileURLToPath(withSpace);
  expect(viaPathname).toContain('%20');
  expect(viaFileURL).not.toContain('%20');
  expect(viaFileURL).toContain('better writer');
 });

 it('#17/S3-9 a space-containing worker path is passed to spawn literally (no %20)', () => {
  const client = createSttClient({
   tsxPath: '/usr/bin/tsx',
   workerPath: '/tmp/better writer/src/stt/worker.ts',
  });
  const fake = makeFakeChild();
  spawnMock.mockReturnValue(fake.child);

  void client.transcribe(new Float32Array(4), 16000);

  expect(spawnMock).toHaveBeenCalled();
  const args = spawnMock.mock.calls[0][1] as string[];
  expect(args).toEqual(['/tmp/better writer/src/stt/worker.ts']);
  expect(args.join(' ')).not.toContain('%20');
 });

 it('#17/S3-9 the default worker path (fileURLToPath) is not percent-encoded', () => {
  const client = createSttClient();
  const fake = makeFakeChild();
  spawnMock.mockReturnValue(fake.child);

  void client.transcribe(new Float32Array(4), 16000);

  const args = spawnMock.mock.calls[0][1] as string[];
  expect(args.join(' ')).not.toContain('%20');
 });
});

describe('dispose()', () => {
 it('is idempotent and settles outstanding work', () => {
  const client = createSttClient();
  const fake = makeFakeChild();
  spawnMock.mockReturnValue(fake.child);

  fireTranscribe(client);

  expect(() => {
   client.dispose();
   client.dispose();
   client.dispose();
  }).not.toThrow();

  // shutdown written exactly once despite repeated dispose() calls.
  const shutdownWrites = fake.child.stdin.write.mock.calls.filter(
   (c) => c[0] === '{"type":"shutdown"}\n',
  );
  expect(shutdownWrites.length).toBe(1);
 });

 it('spawns a fresh worker after dispose (post-dispose reuse does not race SIGKILL)', () => {
  const client = createSttClient();
  spawnMock.mockReturnValue(makeFakeChild().child);
  fireTranscribe(client);
  client.dispose();

  // A request after dispose must spawn a brand-new process.
  spawnMock.mockReturnValue(makeFakeChild().child);
  fireTranscribe(client);

  expect(spawnMock).toHaveBeenCalledTimes(2);
 });
});
