import { describe, expect, it } from 'vitest';
import { createCadence, PAUSE_MS, WORD_THRESHOLD } from './cadence';

/** A run of `n` distinct whitespace-delimited words. */
const ws = (n: number): string => Array.from({ length: n }, () => 'word').join(' ');

describe('defaults', () => {
  it('exposes the documented threshold and pause', () => {
    expect(WORD_THRESHOLD).toBe(30);
    expect(PAUSE_MS).toBe(20_000);
  });
});

describe('createCadence', () => {
  it('arms without firing on the first observe', () => {
    const c = createCadence();
    expect(c.observe('', 0)).toBe('idle');
  });

  it('stays armed while net-new words are under the threshold', () => {
    const c = createCadence({ threshold: 30, pauseMs: 100 });
    expect(c.observe('', 0)).toBe('idle'); // baseline at 0 words
    // 29 net-new words is still under the threshold...
    expect(c.observe(ws(29), 0)).toBe('armed');
    // ...even after the pause has long since elapsed.
    expect(c.observe(ws(29), 10_000)).toBe('armed');
  });

  it('goes ready only once the threshold is met AND the pause has elapsed (29 vs 30 words)', () => {
    const c = createCadence({ threshold: 30, pauseMs: 100 });
    expect(c.observe('', 0)).toBe('idle');
    // 29 words: under threshold, so still armed.
    expect(c.observe(ws(29), 0)).toBe('armed');
    // 30 words meets the threshold, but no pause has elapsed yet.
    expect(c.observe(ws(30), 0)).toBe('armed');
  });

  it('requires the full pause after the threshold is met (pause-1ms vs pause)', () => {
    const c = createCadence({ threshold: 30, pauseMs: 100 });
    expect(c.observe('', 0)).toBe('idle');
    expect(c.observe(ws(30), 0)).toBe('armed');
    // One millisecond shy of the pause: still armed.
    expect(c.observe(ws(30), 99)).toBe('armed');
    // Exactly the pause since the edit: ready.
    expect(c.observe(ws(30), 100)).toBe('ready');
  });

  it('editing again after ready resets lastEditAt so ready needs a fresh pause', () => {
    const c = createCadence({ threshold: 30, pauseMs: 100 });
    expect(c.observe('', 0)).toBe('idle');
    expect(c.observe(ws(30), 0)).toBe('armed');
    expect(c.observe(ws(30), 100)).toBe('ready');
    // A new edit at t=105 restarts the pause clock.
    expect(c.observe(ws(31), 105)).toBe('armed');
    // 45ms later: fresh pause not yet elapsed, even though threshold is met.
    expect(c.observe(ws(31), 150)).toBe('armed');
    // 100ms after the edit: ready again.
    expect(c.observe(ws(31), 205)).toBe('ready');
  });

  it('reset re-arms at the current word count', () => {
    const c = createCadence({ threshold: 30, pauseMs: 100 });
    expect(c.observe('', 0)).toBe('idle');
    expect(c.observe(ws(30), 0)).toBe('armed');
    expect(c.observe(ws(30), 100)).toBe('ready');
    // After firing a question, re-arm at the current 30 words.
    c.reset(ws(30), 150);
    // Net-new is now 0, so it stays armed no matter how long passes.
    expect(c.observe(ws(30), 99_999)).toBe('armed');
  });

  it('a tick with unchanged text does not satisfy the pause (pause counts from the last real edit)', () => {
    const c = createCadence({ threshold: 30, pauseMs: 100 });
    expect(c.observe('', 0)).toBe('idle');
    // The edit lands at t=0; threshold is met.
    expect(c.observe(ws(30), 0)).toBe('armed');
    // An unchanged tick at t=99 is not an edit, so lastEditAt stays 0:
    // 99ms since the edit is still shy of the 100ms pause.
    expect(c.observe(ws(30), 99)).toBe('armed');
    // At t=100 the pause has elapsed since the real edit (t=0) -> ready.
    // Had the unchanged tick moved lastEditAt to 99, this would still be armed.
    expect(c.observe(ws(30), 100)).toBe('ready');
  });

  it('an unchanged tick never moves lastEditAt even when it follows a ready state', () => {
    const c = createCadence({ threshold: 30, pauseMs: 100 });
    expect(c.observe('', 0)).toBe('idle');
    expect(c.observe(ws(30), 0)).toBe('armed');
    expect(c.observe(ws(30), 100)).toBe('ready');
    // Re-feeding identical text repeatedly must not reset the pause clock.
    expect(c.observe(ws(30), 101)).toBe('ready');
    expect(c.observe(ws(30), 150)).toBe('ready');
  });
});
