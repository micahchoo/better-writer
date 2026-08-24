/**
 * save-coordinator unit tests: debounce coalescing, the single-retry
 * failure path, flush-on-demand (keepalive), and dispose. The store is a
 * fake object — never the real draft-store classes — so this file stays
 * decoupled from the store adapters' implementation details.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Note } from './draft-store';
import { SaveCoordinator } from './save-coordinator';

const notes: Note[] = [
  { start: 0, end: 5, fragment: 'hello', question: 'Where does this start?', ts: 1 },
];

interface FakeStore {
  save: Mock;
  load: Mock;
  loadAnnotations: Mock;
}

function makeStore(): FakeStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(''),
    loadAnnotations: vi.fn().mockResolvedValue([]),
  };
}

function makeCoordinator(store: FakeStore, onError: Mock = vi.fn()) {
  const coordinator = new SaveCoordinator({ getStore: () => store, onError });
  return { coordinator, onError };
}

/** Like makeCoordinator but also records onSaveState pulses in array order. */
function makePulseCoordinator(store: FakeStore, onError: Mock = vi.fn()) {
  const phases: Array<'saving' | 'saved'> = [];
  const coordinator = new SaveCoordinator({
    getStore: () => store,
    onError,
    onSaveState: (p) => phases.push(p),
  });
  return { coordinator, phases, onError };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SaveCoordinator', () => {
  it('debounces edit() and saves the latest text and notes', async () => {
    const store = makeStore();
    const { coordinator } = makeCoordinator(store);

    coordinator.edit('hello', notes);
    expect(store.save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith('hello', notes);
  });

  it('coalesces rapid edits into exactly one save with the final payload', async () => {
    const store = makeStore();
    const { coordinator } = makeCoordinator(store);

    coordinator.edit('one', []);
    await vi.advanceTimersByTimeAsync(500);
    coordinator.edit('two', []);
    await vi.advanceTimersByTimeAsync(500);
    coordinator.edit('three', notes);

    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith('three', notes);
  });

  it('keeps a failed payload, retries once after 1 s, and raises no error when the retry succeeds', async () => {
    const store = makeStore();
    store.save.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined);
    const { coordinator, onError } = makeCoordinator(store);

    coordinator.edit('hello', notes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces the error once after two failed saves and stops retrying', async () => {
    const store = makeStore();
    const boom = new Error('boom');
    store.save.mockRejectedValue(boom);
    const { coordinator, onError } = makeCoordinator(store);

    coordinator.edit('hello', notes);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);

    // No further retries: the chain stopped.
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('edit during detecting mode (null store) yields a failure signal, retains the payload, and never pulses saved', async () => {
    let store: FakeStore | null = null;
    const onError = vi.fn();
    const phases: Array<'saving' | 'saved'> = [];
    const coordinator = new SaveCoordinator({
      getStore: () => store,
      onError,
      onSaveState: (p) => phases.push(p),
    });

    coordinator.edit('hello', notes);
    await vi.advanceTimersByTimeAsync(1000); // first attempt: null store -> silent retry armed
    expect(onError).not.toHaveBeenCalled();
    expect(phases).toEqual(['saving']);

    await vi.advanceTimersByTimeAsync(1000); // retry: still null -> onError surfaces
    expect(onError).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['saving', 'saving']);
    expect(phases).not.toContain('saved');

    // The payload was never dropped: once a store appears, flush() persists it.
    store = makeStore();
    await coordinator.flush();
    expect(store.save).toHaveBeenCalledWith('hello', notes, undefined);
  });

  it('flush() sends immediately without waiting on the timer, passes keepalive through, and clears the payload', async () => {
    const store = makeStore();
    const { coordinator } = makeCoordinator(store);

    coordinator.edit('hello', notes);
    const flushPromise = coordinator.flush({ keepalive: true });
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith('hello', notes, { keepalive: true });

    await flushPromise;
    // The cancelled debounce never fires — no double send.
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending resolves without calling save', async () => {
    const store = makeStore();
    const { coordinator } = makeCoordinator(store);

    await coordinator.flush({ keepalive: true });
    expect(store.save).not.toHaveBeenCalled();
  });

  it('flush() failure surfaces the error once, keeps the payload, and the next edit() re-arms', async () => {
    const store = makeStore();
    const boom = new Error('boom');
    store.save.mockRejectedValueOnce(boom);
    const { coordinator, onError } = makeCoordinator(store);

    coordinator.edit('hello', notes);
    await coordinator.flush({ keepalive: true });
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);

    // The failed payload is still pending — a fresh edit starts a new cycle.
    coordinator.edit('world', notes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(store.save).toHaveBeenLastCalledWith('world', notes);
  });

  it('dispose() cancels the pending debounced save', async () => {
    const store = makeStore();
    const { coordinator } = makeCoordinator(store);

    coordinator.edit('hello', notes);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('persistNow() sends immediately, superseding a pending debounce', async () => {
    const store = makeStore();
    const { coordinator } = makeCoordinator(store);

    // A keystroke armed the debounced save with its snapshot.
    coordinator.edit('typed text', notes);

    // A note-op lands inside the debounce window and must win.
    await coordinator.persistNow('typed text', []);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith('typed text', [], undefined);

    // The stale debounced snapshot must NOT fire afterwards.
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('persistNow() failure keeps the payload so the next edit re-arms', async () => {
    const store = makeStore();
    store.save.mockRejectedValueOnce(new Error('server down'));
    const { coordinator, onError } = makeCoordinator(store);

    await coordinator.persistNow('keep me', notes);
    expect(onError).toHaveBeenCalledTimes(1);

    // Nothing was lost: an edit later persists the latest payload.
    coordinator.edit('edit after failure', notes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenLastCalledWith('edit after failure', notes);
  });

  it('persistNow+edit interleave leaves clearTimers able to cancel the live timer (no orphaned timer)', async () => {
    const store = makeStore();
    let release!: () => void;
    store.save
      .mockImplementationOnce(() => new Promise<void>((res) => { release = res; }))
      .mockResolvedValue(undefined);
    const { coordinator } = makeCoordinator(store);

    // A keystroke arms the debounced save.
    coordinator.edit('a', notes);
    // A note-op forces an immediate flush; its save is held in flight.
    const flushPromise = coordinator.persistNow('b', notes);
    // A newer edit lands mid-flight, re-arming the debounce for the newest payload.
    coordinator.edit('c', notes);
    release(); // the held flush save completes
    await flushPromise;
    await vi.advanceTimersByTimeAsync(0);

    // Only the flush save has happened; the live debounce for 'c' must be
    // cancellable — dispose() cancels it, so no save fires afterward.
    expect(store.save).toHaveBeenCalledTimes(1);
    coordinator.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.save).toHaveBeenCalledTimes(1);
  });
});

describe('SaveCoordinator onSaveState', () => {
  it('emits saving then saved after a debounced edit', async () => {
    const store = makeStore();
    const { coordinator, phases } = makePulseCoordinator(store);

    coordinator.edit('hello', notes);
    await vi.advanceTimersByTimeAsync(1000);

    expect(store.save).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['saving', 'saved']);
  });

  it('emits saving on each attempt and saved once when the silent retry recovers', async () => {
    const store = makeStore();
    store.save.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined);
    const { coordinator, phases, onError } = makePulseCoordinator(store);

    // First attempt fails silently; a retry is armed — no 'saved' yet.
    coordinator.edit('hello', notes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(phases).toEqual(['saving']);

    // The retry succeeds -> exactly one 'saved', no error surfaced.
    await vi.advanceTimersByTimeAsync(1000);
    expect(phases).toEqual(['saving', 'saving', 'saved']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('suppresses saved when a newer payload arrives mid-save, then pulses on the follow-up', async () => {
    const store = makeStore();
    // Hold the first save in flight until the test releases it.
    let releaseFirst!: () => void;
    store.save
      .mockImplementationOnce(() => new Promise<void>((res) => { releaseFirst = res; }))
      .mockResolvedValue(undefined);
    const { coordinator, phases } = makePulseCoordinator(store);

    coordinator.edit('first', notes);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['saving']);

    // A newer edit supersedes the in-flight payload.
    coordinator.edit('newer', []);
    releaseFirst(); // in-flight save completes with a stale payload
    await vi.advanceTimersByTimeAsync(0);

    // The superseded save must not pulse 'saved'; a follow-up is re-armed.
    expect(phases).toEqual(['saving']);

    // The follow-up saves the newer payload and emits saving then saved.
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(phases).toEqual(['saving', 'saving', 'saved']);
  });

  it('persistNow emits saving then saved on an immediate flush', async () => {
    const store = makeStore();
    const { coordinator, phases } = makePulseCoordinator(store);

    await coordinator.persistNow('hello', notes);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['saving', 'saved']);
  });
});
