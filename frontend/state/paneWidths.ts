'use client';

import { useSyncExternalStore } from 'react';

/**
 * Persisted numeric pane-WIDTH stores for the resizable side panes, modeled on
 * the boolean collapse stores in `state/uiCollapse.ts`: a module-level
 * singleton kept in sync with localStorage and exposed to React via
 * `useSyncExternalStore` (SSR-safe — the server snapshot is always `null`, so
 * hydration renders the design default and the stored width applies right
 * after, exactly like the collapse toggles).
 *
 * Value semantics: `null` means "no user override — use the pane's design
 * default" (which for the thread list is a FLUID fr-based track, not a px
 * value). A number is a user-chosen width in px, always clamped to [min, max].
 *
 * `preview()` is the live during-drag channel: it updates + notifies without
 * touching localStorage (no 60Hz disk writes); `set()` clamps + persists;
 * `reset()` clears the stored key and returns the pane to its design default.
 */

export interface PaneWidthStore {
  /** localStorage key, e.g. `eops:pane:mail-folders`. */
  key: string;
  /** Hard clamp bounds (px). */
  min: number;
  max: number;
  /** Design-default width in px, or null when the default is fluid (fr). */
  defaultWidth: number | null;
  /** Current override (px) or null when unset. */
  get(): number | null;
  /** Clamp helper shared by drag + keyboard paths. */
  clamp(next: number): number;
  /** Live drag value: update + notify, NO persistence. */
  preview(next: number): void;
  /** Clamp + persist + notify (drag end / keyboard nudge). */
  set(next: number): void;
  /** Remove the override: clears the stored key, back to the design default. */
  reset(): void;
  /** React hook: subscribe to the override value (null = design default). */
  use(): number | null;
}

function readStoredWidth(key: string, min: number, max: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return Math.min(max, Math.max(min, parsed));
  } catch {
    // localStorage can be unavailable in private contexts.
    return null;
  }
}

function makePaneWidthStore(config: {
  key: string;
  min: number;
  max: number;
  defaultWidth: number | null;
}): PaneWidthStore {
  const { key, min, max, defaultWidth } = config;
  let current: number | null =
    typeof window === 'undefined' ? null : readStoredWidth(key, min, max);
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function clamp(next: number): number {
    return Math.min(max, Math.max(min, Math.round(next)));
  }

  function preview(next: number): void {
    const clamped = clamp(next);
    if (clamped === current) return;
    current = clamped;
    emit();
  }

  function set(next: number): void {
    const clamped = clamp(next);
    const changed = clamped !== current;
    current = clamped;
    try {
      localStorage.setItem(key, String(clamped));
    } catch {
      // In-memory value still works for this page lifetime.
    }
    if (changed) emit();
  }

  function reset(): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore — in-memory reset still applies.
    }
    if (current === null) return;
    current = null;
    emit();
  }

  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  function getSnapshot(): number | null {
    return current;
  }

  function getServerSnapshot(): number | null {
    return null;
  }

  return {
    key,
    min,
    max,
    defaultWidth,
    get: getSnapshot,
    clamp,
    preview,
    set,
    reset,
    use: () =>
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
  };
}

/**
 * Effective width for layout: the user override, falling back to the design
 * default (`null` only for panes whose default is fluid — the thread list).
 */
export function usePaneWidth(store: PaneWidthStore): number | null {
  const value = store.use();
  return value ?? store.defaultWidth;
}

/** Far-left section nav (MailIconNav) — EXPANDED width; compact 52px is fixed. */
export const sectionNavPane = makePaneWidthStore({
  key: 'eops:pane:section-nav',
  min: 180,
  max: 300,
  defaultWidth: 208,
});

/** /mail accounts + folders column (expanded; the 56px avatar rail is fixed). */
export const mailFoldersPane = makePaneWidthStore({
  key: 'eops:pane:mail-folders',
  min: 200,
  max: 420,
  defaultWidth: 236,
});

/**
 * /mail conversation-list column. Default is FLUID — `minmax(300px,1.15fr)` —
 * so defaultWidth is null; a user drag pins it to px (still `minmax(300px,Npx)`
 * so over-constrained viewports degrade exactly like today).
 */
export const mailThreadListPane = makePaneWidthStore({
  key: 'eops:pane:mail-list',
  min: 300,
  max: 560,
  defaultWidth: null,
});

/** /mail right agent-activity rail (expanded; the 44px strip is fixed). */
export const mailRailPane = makePaneWidthStore({
  key: 'eops:pane:mail-rail',
  min: 260,
  max: 480,
  defaultWidth: 320,
});

/** AppShell right Agent Activity rail (dashboard / approvals / cleanup / …). */
export const shellRailPane = makePaneWidthStore({
  key: 'eops:pane:shell-rail',
  min: 260,
  max: 480,
  defaultWidth: 320,
});
