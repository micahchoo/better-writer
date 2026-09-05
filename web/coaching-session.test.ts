import { describe, expect, it, vi } from 'vitest';
import type { Coach, CoachInput, CoachResult } from '../src/core/types.js';
import { CoachingSession } from './coaching-session.js';
import { planSweep } from './coach-sweep.js';

const input: CoachInput = { textWindow: 'A sentence.', genre: 'fiction', cursorOffset: 0 };
const result: CoachResult = { kind: 'question', question: 'Why?', source: 'seed' };
function pendingCoach() {
  let resolve!: (result: CoachResult) => void;
  let signal: AbortSignal | undefined;
  const coach: Coach = { ask: vi.fn((_input, passedSignal) => {
    signal = passedSignal;
    return new Promise<CoachResult>(yes => { resolve = yes; });
  }) };
  return { coach, resolve: (value = result) => resolve(value), signal: () => signal };
}

describe('CoachingSession', () => {
  it('allows only one auto ask and returns to idle on completion', async () => {
    const pending = pendingCoach(); const onState = vi.fn();
    const session = new CoachingSession(pending.coach, { onState });
    const running = session.ask(input);
    expect(session.state).toBe('asking');
    expect(await session.ask(input)).toBeUndefined();
    expect(pending.coach.ask).toHaveBeenCalledTimes(1);
    pending.resolve();
    expect(await running).toEqual(result);
    expect(session.state).toBe('idle');
    expect(onState.mock.calls.flat()).toEqual(['asking', 'idle']);
  });
  it('cancel permits immediate restart and late completion cannot reset new state', async () => {
    const old = pendingCoach(); const newer = pendingCoach();
    const session = new CoachingSession(old.coach);
    const first = session.ask(input);
    session.configure(newer.coach);
    expect(old.signal()?.aborted).toBe(true);
    const second = session.ask(input);
    expect(await first).toBeUndefined();
    old.resolve();
    await Promise.resolve();
    expect(session.state).toBe('asking');
    newer.resolve();
    expect(await second).toEqual(result);
  });
  it('sweep cancels auto ask and excludes auto ask until finished', async () => {
    const pending = pendingCoach();
    const session = new CoachingSession(pending.coach);
    const first = session.ask(input);
    const oldSignal = pending.signal();
    const sweep = session.sweep(planSweep(input.textWindow), { draft: input.textWindow, genre: 'fiction', onNote() {} });
    expect(oldSignal?.aborted).toBe(true);
    expect(await first).toBeUndefined();
    expect(session.state).toBe('sweeping');
    expect(await session.ask(input)).toBeUndefined();
    session.cancel();
    expect(await sweep).toBeUndefined();
    expect(session.state).toBe('idle');
  });
  it('dispose suppresses future callbacks and late arrivals', async () => {
    const pending = pendingCoach(); const onState = vi.fn(); const onNote = vi.fn();
    const session = new CoachingSession(pending.coach, { onState });
    const running = session.sweep(planSweep(input.textWindow), { draft: input.textWindow, genre: 'fiction', onNote });
    session.dispose();
    const count = onState.mock.calls.length;
    expect(await running).toBeUndefined();
    pending.resolve();
    await Promise.resolve();
    expect(onNote).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(count);
    expect(await session.ask(input)).toBeUndefined();
  });
  it('failure returns ownership to idle for retry', async () => {
    const session = new CoachingSession({ ask: async () => { throw new Error('offline'); } });
    await expect(session.ask(input)).rejects.toThrow('offline');
    expect(session.state).toBe('idle');
  });
});
