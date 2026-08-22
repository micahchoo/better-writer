import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePullOutput, pullSeed } from './seed.js';

// Mock execFile so pullSeed's retry path is exercised without shelling out.
// seed.ts builds execFileAsync via promisify(execFile), so the mock resolves
// through the callback (its last argument), exactly like the real thing.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

/** Exactly what `retrieve.py pull` prints: a JSON array, indent=2. */
const CANNED_PULL = JSON.stringify(
 [
  {
   id: 'lg-steering-1',
   question: 'What is at stake here?',
   verb: 'concept-form',
   genre: ['fiction'],
   source: {
    book: 'Steering the Craft',
    author: 'Ursula K. Le Guin',
    chapter: 'ch1',
    quote: 'Some quoted text.',
   },
  },
 ],
 null,
 2,
);

/** Resolve execFile's callback (its last argument) with a canned stdout. */
function respondWith(stdout: string) {
 return (...args: unknown[]) => {
  const cb = args[args.length - 1] as (
   err: Error | null,
   result?: { stdout: string },
  ) => void;
  cb(null, { stdout });
 };
}

/** Resolve execFile's callback with a failure. */
function failWith(err: Error) {
 return (...args: unknown[]) => {
  const cb = args[args.length - 1] as (
   err: Error | null,
   result?: { stdout: string },
  ) => void;
  cb(err);
 };
}

describe('parsePullOutput', () => {
 it('parses a canned retrieve.py JSON array and returns the first seed', () => {
  const seed = parsePullOutput(CANNED_PULL);
  expect(seed.id).toBe('lg-steering-1');
  expect(seed.question).toBe('What is at stake here?');
  expect(seed.genre).toEqual(['fiction']);
  expect(seed.source.author).toBe('Ursula K. Le Guin');
 });

 it('throws a clear error on an empty array', () => {
  expect(() => parsePullOutput('[]')).toThrow(/no seeds/);
 });

 it('throws a clear error on unparseable output', () => {
  expect(() => parsePullOutput('not json at all')).toThrow(/invalid JSON/);
 });

 it('throws a clear error on a non-array payload', () => {
  expect(() => parsePullOutput('{"question": "what?"}')).toThrow(/no seeds/);
 });

 it('throws a clear error on a malformed seed', () => {
  expect(() => parsePullOutput(JSON.stringify([{ id: 'x' }]))).toThrow(/malformed seed/);
 });
});

describe('pullSeed', () => {
 beforeEach(() => {
  execFileMock.mockReset();
 });

 it('passes --verb when a verb is given and does not retry on success', async () => {
  execFileMock.mockImplementationOnce(respondWith(CANNED_PULL));
  const seed = await pullSeed('fiction', 'rewrite');
  expect(seed.id).toBe('lg-steering-1');
  expect(execFileMock).toHaveBeenCalledTimes(1);
  expect(execFileMock.mock.calls[0][1]).toEqual([
   expect.stringMatching(/retrieve\.py$/),
   'pull',
   '--genre',
   'fiction',
   '--verb',
   'rewrite',
  ]);
 });

 it('retries without --verb when the verb bucket is empty (empty JSON array)', async () => {
  execFileMock
   .mockImplementationOnce(respondWith('[]'))
   .mockImplementationOnce(respondWith(CANNED_PULL));
  const seed = await pullSeed('fiction', 'rewrite');
  expect(seed.id).toBe('lg-steering-1');
  expect(execFileMock).toHaveBeenCalledTimes(2);
  expect(execFileMock.mock.calls[0][1]).toEqual([
   expect.stringMatching(/retrieve\.py$/),
   'pull',
   '--genre',
   'fiction',
   '--verb',
   'rewrite',
  ]);
  expect(execFileMock.mock.calls[1][1]).toEqual([
   expect.stringMatching(/retrieve\.py$/),
   'pull',
   '--genre',
   'fiction',
  ]);
 });

 it('retries without --verb when the verb\'d exec call rejects', async () => {
  execFileMock
   .mockImplementationOnce(failWith(Object.assign(new Error('python exited 1'), { stderr: 'no seeds for verb' })))
   .mockImplementationOnce(respondWith(CANNED_PULL));
  const seed = await pullSeed('fiction', 'elucidate');
  expect(seed.id).toBe('lg-steering-1');
  expect(execFileMock).toHaveBeenCalledTimes(2);
  expect(execFileMock.mock.calls[1][1]).not.toEqual(expect.arrayContaining(['--verb']));
 });

 it('propagates exec failure without retrying when no verb is given', async () => {
  execFileMock.mockImplementationOnce(
   failWith(Object.assign(new Error('boom'), { stderr: 'python exploded' })),
  );
  await expect(pullSeed('fiction')).rejects.toThrow(
   /seed pull failed for genre "fiction": python exploded/,
  );
  expect(execFileMock).toHaveBeenCalledTimes(1);
 });
});
