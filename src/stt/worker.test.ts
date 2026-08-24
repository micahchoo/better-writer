import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64ToFloat32, pushAudio, registerTestStream } from './worker';

afterEach(() => {
 vi.restoreAllMocks();
});

describe('worker streaming decode (S3-11)', () => {
 it('base64ToFloat32 throws a RangeError on a payload not multiple of 4 bytes', () => {
  // 5 bytes → 5 / 4 = 1.25 samples → non-integer length → RangeError.
  const fiveBytes = Buffer.alloc(5).toString('base64');
  expect(fiveBytes).not.toContain(' ');
  expect(() => base64ToFloat32(fiveBytes)).toThrow(RangeError);
 });

 it('a malformed audio payload emits stream-error instead of hanging the parent', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  registerTestStream('s-1');

  // pushAudio decodes inside its try: a bad payload must be caught and
  // reported as a stream-error (the parent's end() then settles) — not
  // escape into the queue's log-only catch and never answer.
  await pushAudio('s-1', Buffer.alloc(5).toString('base64'), 16000);

  const sent = write.mock.calls.map((c) => String(c[0])).join('');
  expect(sent).toContain('stream-error');
  expect(sent).toContain('"id":"s-1"');
 });
});
