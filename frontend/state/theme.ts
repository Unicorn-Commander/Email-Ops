'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'theme';
const DEFAULT_PREF: ThemePref = 'dark';

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // localStorage can be unavailable in private contexts.
  }
  return DEFAULT_PREF;
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return pref;
}

export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
}

let currentPref: ThemePref = typeof window === 'undefined' ? DEFAULT_PREF : readThemePref();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function syncDom(): void {
  applyResolvedTheme(resolveTheme(currentPref));
}

export function setThemePref(next: ThemePref): void {
  currentPref = next;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // In-memory preference still works for this page lifetime.
  }
  syncDom();
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): ThemePref {
  return currentPref;
}

function getServerSnapshot(): ThemePref {
  return DEFAULT_PREF;
}

if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (currentPref === 'system') {
      syncDom();
      emit();
    }
  };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
  } else if (typeof mq.addListener === 'function') {
    mq.addListener(onChange);
  }
}

if (typeof document !== 'undefined') {
  syncDom();
}

export function useTheme(): {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (next: ThemePref) => void;
  cycle: () => void;
} {
  const pref = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    syncDom();
  }, []);

  const setPref = useCallback((next: ThemePref) => setThemePref(next), []);
  const cycle = useCallback(() => {
    const order: ThemePref[] = ['light', 'dark', 'system'];
    const idx = order.indexOf(pref);
    setThemePref(order[(idx + 1) % order.length] ?? 'dark');
  }, [pref]);

  return { pref, resolved: resolveTheme(pref), setPref, cycle };
}
