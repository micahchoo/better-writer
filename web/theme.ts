/**
 * theme: the app's dark/light theme state — resolve, apply, persist.
 *
 * The theme is owned by a `data-theme` attribute on <html>; style.css keys
 * every color token off it (:root = dark defaults, [data-theme='light']
 * overrides). The CM6 editor re-styles instantly on swap because its
 * EditorView.theme references the same var(--token) values, so no editor
 * remount or Compartment machinery is needed.
 *
 * Resolution order: a stored preference (localStorage 'better-writer:theme')
 * wins; otherwise the OS prefers-color-scheme; otherwise dark.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'better-writer:theme';

/** Read the persisted preference, or null when unset / storage disabled. */
export function resolveStoredTheme(): Theme | null {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch {
    return null;
  }
}

/** Resolve the effective theme: stored preference, else OS, else dark. */
export function resolveTheme(): Theme {
  const stored = resolveStoredTheme();
  if (stored) return stored;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/** Reflect the theme onto <html data-theme> — the single source CSS reads. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

/** Persist the preference without touching the DOM. */
export function persistTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage disabled / quota exceeded: the choice just doesn't survive a reload.
  }
}

/** Apply + persist in one call (the toggle handler). */
export function setTheme(theme: Theme): void {
  applyTheme(theme);
  persistTheme(theme);
}

/**
 * Resolve + apply the theme once, before React mounts, so the first paint is
 * already in the right scheme (no dark-flash for a stored light preference).
 */
export function initTheme(): Theme {
  const theme = resolveTheme();
  applyTheme(theme);
  return theme;
}

/**
 * React binding: returns the current theme and a setter. Applies the theme to
 * <html data-theme> whenever it changes; the setter also persists.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(resolveTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const set = useCallback((next: Theme) => {
    setThemeState(next);
    persistTheme(next);
  }, []);
  return [theme, set];
}
