import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@mariozechner/pi-ai', () => ({ complete: vi.fn() }));
import { complete } from '@mariozechner/pi-ai';
import { makeComplete } from './llm.js';
const provider = vi.mocked(complete);

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); provider.mockReset(); });

describe('makeComplete cancellation', () => {
  it('rejects before invoking the provider when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(makeComplete()('', [], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('forwards cancellation and preserves the caller reason', async () => {
    provider.mockImplementation((_model, _context, opts) => new Promise((_resolve, reject) => {
      opts!.signal!.addEventListener('abort', () => reject(new Error('provider aborted')));
    }));
    const controller = new AbortController();
    const pending = makeComplete()('', [], { signal: controller.signal });
    const reason = new Error('request closed');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(provider.mock.calls[0][2]?.signal?.aborted).toBe(true);
  });

  it('reports timeout as a model failure rather than caller cancellation', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    provider.mockImplementation((_model, _context, opts) => new Promise((_resolve, reject) => {
      opts!.signal!.addEventListener('abort', () => reject(new Error('provider aborted')));
    }));
    const controller = new AbortController();
    const pending = makeComplete({ timeoutMs: 10 })('', [], { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow('timed out after 0.01s');
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(controller.signal.aborted).toBe(false);
  });

  it('checks caller cancellation even if the provider returns an aborted response', async () => {
    const controller = new AbortController();
    provider.mockImplementation(async () => {
      controller.abort();
      return { stopReason: 'aborted', content: [] } as unknown as Awaited<ReturnType<typeof complete>>;
    });
    await expect(makeComplete()('', [], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
