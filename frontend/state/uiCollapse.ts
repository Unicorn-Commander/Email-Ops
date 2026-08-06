'use client';

import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';

/**
 * Persisted boolean UI-state stores (collapse toggles), modeled on the theme
 * store in `state/theme.ts`: a module-level singleton kept in sync with
 * localStorage and exposed to React via `useSyncExternalStore`.
 *
 * Two toggles live here:
 *   • nav-collapsed  — the global AppShell left nav (icon-rail vs full).
 *   • mbx-collapsed  — the /mail leftmost mailbox-picker pane.
 *
 * The nav store ALSO reflects its state onto `<html class="eops-nav-collapsed">`
 * so the pre-hydration inline script in app/layout.tsx can set the collapsed
 * width before React mounts (no width flash on reload).
 */

interface BoolStore {
  /** Read the current value (module singleton). */
  get(): boolean;
  /** Set to an explicit value; persists + notifies + syncs DOM. */
  set(next: boolean): void;
  /** Flip the current value. */
  toggle(): void;
  /** React hook: subscribe to the value. */
  use(): boolean;
}

function readStored(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    // localStorage can be unavailable in private contexts.
  }
  return fallback;
}

function makeBoolStore(
  key: string,
  defaultValue: boolean,
  syncDom?: (value: boolean) => void,
): BoolStore {
  let current = typeof window === 'undefined' ? defaultValue : readStored(key, defaultValue);
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  function set(next: boolean): void {
    if (next === current) {
      // Still ensure DOM reflects state on first call.
      if (syncDom) syncDom(next);
      return;
    }
    current = next;
    try {
      localStorage.setItem(key, next ? '1' : '0');
    } catch {
      // In-memory value still works for this page lifetime.
    }
    if (syncDom) syncDom(next);
    emit();
  }

  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  function getSnapshot(): boolean {
    return current;
  }

  function getServerSnapshot(): boolean {
    return defaultValue;
  }

  // Reflect the persisted value onto the DOM at module-eval time (client only),
  // matching the pre-hydration inline script so React and the DOM agree.
  if (typeof document !== 'undefined' && syncDom) {
    syncDom(current);
  }

  return {
    get: getSnapshot,
    set,
    toggle: () => set(!current),
    use: () =>
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
  };
}

/** localStorage key + <html> class for the global app-nav collapse. */
export const NAV_COLLAPSED_KEY = 'eops:shell:nav-collapsed';
export const NAV_COLLAPSED_CLASS = 'eops-nav-collapsed';

function syncNavClass(collapsed: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(NAV_COLLAPSED_CLASS, collapsed);
}

/** Global left-nav (AppShell) collapse state. Default: expanded. */
export const navCollapsedStore = makeBoolStore(NAV_COLLAPSED_KEY, false, syncNavClass);

/** localStorage key for the /mail mailbox-picker pane collapse. */
export const MBX_COLLAPSED_KEY = 'eops:mail:mbx-collapsed';

/** /mail mailbox-picker pane collapse state. Default: expanded. */
export const mailboxCollapsedStore = makeBoolStore(MBX_COLLAPSED_KEY, false);

/** localStorage key for the /mail right agent-activity rail collapse. */
export const RAIL_COLLAPSED_KEY = 'eops:mail:rail-collapsed';

/** /mail right agent-activity rail collapse state. Default: OPEN (expanded). */
export const railCollapsedStore = makeBoolStore(RAIL_COLLAPSED_KEY, false);

/** localStorage key for the far-left section icon-rail expand (icons ↔ icons+labels). */
export const SECTION_RAIL_EXPANDED_KEY = 'eops:shell:section-rail-expanded';

/** Section icon-rail (MailIconNav) expand state. Default: COMPACT (icons only). */
export const sectionRailExpandedStore = makeBoolStore(SECTION_RAIL_EXPANDED_KEY, false);

/** Convenience hooks with a stable toggle callback. */
export function useNavCollapsed(): [boolean, () => void] {
  const collapsed = navCollapsedStore.use();
  const toggle = useCallback(() => navCollapsedStore.toggle(), []);
  return [collapsed, toggle];
}

export function useMailboxCollapsed(): [boolean, () => void] {
  const collapsed = mailboxCollapsedStore.use();
  const toggle = useCallback(() => mailboxCollapsedStore.toggle(), []);
  return [collapsed, toggle];
}

export function useRailCollapsed(): [boolean, () => void] {
  const collapsed = railCollapsedStore.use();
  const toggle = useCallback(() => railCollapsedStore.toggle(), []);
  return [collapsed, toggle];
}

export function useSectionRailExpanded(): [boolean, () => void] {
  const expanded = sectionRailExpandedStore.use();
  const toggle = useCallback(() => sectionRailExpandedStore.toggle(), []);
  return [expanded, toggle];
}
