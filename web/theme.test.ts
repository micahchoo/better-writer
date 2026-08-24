/**
 * theme unit tests: resolution order, DOM reflection, and persistence.
 * Runs headless in jsdom with localStorage and matchMedia both mocked, so no
 * real browser needed. The pure functions are the contract; the useTheme hook
 * is a thin binding on top of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  initTheme,
  persistTheme,
  resolveStoredTheme,
  resolveTheme,
  setTheme,
} from './theme';

interface MatchMediaStub {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MatchMediaStub => ({
      matches: query.includes('dark') ? dark : !dark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
}

/** matchMedia is unavailable (e.g. storage-less embedding): resolveTheme must not throw. */
function stubMatchMediaMissing(): void {
  vi.stubGlobal('matchMedia', undefined);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveStoredTheme', () => {
  it('is null when nothing is stored', () => {
    expect(resolveStoredTheme()).toBeNull();
  });

  it('returns the stored preference for a valid value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(resolveStoredTheme()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(resolveStoredTheme()).toBe('dark');
  });

  it('is null for an unrecognized stored value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(resolveStoredTheme()).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('a stored preference wins over the OS preference', () => {
    stubMatchMedia(true); // OS says dark
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(resolveTheme()).toBe('light');
  });

  it('falls back to the OS preference when nothing is stored', () => {
    stubMatchMedia(true);
    expect(resolveTheme()).toBe('dark');
    stubMatchMedia(false);
    expect(resolveTheme()).toBe('light');
  });

  it('falls back to dark when matchMedia is unavailable', () => {
    stubMatchMediaMissing();
    expect(resolveTheme()).toBe('dark');
  });
});

describe('applyTheme / persistTheme / setTheme', () => {
  it('applyTheme reflects the theme onto <html data-theme>', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persistTheme writes the preference', () => {
    persistTheme('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('setTheme applies and persists', () => {
    setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('setTheme survives a storage failure (quota/private mode)', () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      setTheme('dark');
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe('initTheme', () => {
  it('applies and returns the resolved theme (stored preference)', () => {
    stubMatchMedia(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(initTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies the OS-derived default when nothing is stored', () => {
    stubMatchMedia(false);
    expect(initTheme()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
