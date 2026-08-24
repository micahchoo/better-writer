/**
 * save-indicator unit tests: the debounced save-status display machine.
 * Timers are faked so the pending/sticky windows are asserted precisely.
 * The coordinator's raw 'saving'/'saved' pulses feed saveStarted/saveSucceeded;
 * these tests pin the flicker-free display semantics on top of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveIndicator, SAVE_PENDING_MS, SAVE_STICKY_MS, type SaveIndicatorDisplay } from './save-indicator';

function makeIndicator() {
  const displays: SaveIndicatorDisplay[] = [];
  const indicator = new SaveIndicator((d) => displays.push(d));
  return { indicator, displays };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SaveIndicator', () => {
  it('never shows Saving for a fast save: pending window elapses with nothing on screen', () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveStarted();
    // Save confirms well inside the 400ms pending window.
    indicator.saveSucceeded();
    expect(displays).toEqual(['saved']);
  });

  it("doesn't transition to saving before the pending window elapses", () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveStarted();
    vi.advanceTimersByTime(SAVE_PENDING_MS - 1);
    expect(displays).toEqual([]);
  });

  it('shows Saving only after a save lingers past the pending window', () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveStarted();
    vi.advanceTimersByTime(SAVE_PENDING_MS);
    expect(displays).toEqual(['saving']);
  });

  it('reverts Saved to idle after the sticky window', () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveSucceeded();
    expect(displays).toEqual(['saved']);
    vi.advanceTimersByTime(SAVE_STICKY_MS - 1);
    expect(displays).toEqual(['saved']);
    vi.advanceTimersByTime(1);
    expect(displays).toEqual(['saved', 'idle']);
  });

  it('cancels a pending Saving timer the moment a save confirms (no flicker on a slow-then-fast burst)', () => {
    const { indicator, displays } = makeIndicator();
    // Slow save: crosses the pending window.
    indicator.saveStarted();
    vi.advanceTimersByTime(SAVE_PENDING_MS);
    expect(displays).toEqual(['saving']);
    indicator.saveSucceeded();
    // A rapid queued save arrives and confirms fast — it must not flash Saving.
    indicator.saveStarted();
    vi.advanceTimersByTime(100);
    indicator.saveSucceeded();
    expect(displays).toEqual(['saving', 'saved']);
    // And the second confirmation restarts the sticky window once.
    vi.advanceTimersByTime(SAVE_STICKY_MS);
    expect(displays).toEqual(['saving', 'saved', 'idle']);
  });

  it('a fast queued save that never crossed pending shows only a single Saved', () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveStarted();
    indicator.saveSucceeded();
    indicator.saveStarted();
    indicator.saveSucceeded();
    expect(displays).toEqual(['saved']);
  });

  it('a second saveStarted supersedes the first pending timer (single Saving transition)', () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveStarted();
    indicator.saveStarted();
    vi.advanceTimersByTime(SAVE_PENDING_MS);
    expect(displays).toEqual(['saving']);
  });

  it('a new saveStarted mid-sticky window extends Saved without reverting to idle', () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveSucceeded();
    vi.advanceTimersByTime(SAVE_STICKY_MS - 500);
    indicator.saveStarted();
    indicator.saveSucceeded();
    // Sticky restarted: 500ms of the old window already elapsed, but the new
    // confirmation re-arms the full sticky window.
    vi.advanceTimersByTime(SAVE_STICKY_MS - 1);
    expect(displays).toEqual(['saved']);
    vi.advanceTimersByTime(1);
    expect(displays).toEqual(['saved', 'idle']);
  });

  it('dispose cancels pending timers so nothing fires afterward', () => {
    const { indicator, displays } = makeIndicator();
    indicator.saveStarted();
    indicator.dispose();
    vi.advanceTimersByTime(SAVE_PENDING_MS + SAVE_STICKY_MS);
    expect(displays).toEqual([]);
  });
});
