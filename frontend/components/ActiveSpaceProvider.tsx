'use client';

/**
 * Ambient active-Space state, shared by the Top-bar switcher AND the scoped
 * pages (`/mail`, `/agents`) so they all read the SAME active Space.
 *
 * It is a thin context mounted high in `AppShell` (around `ProductChrome`): it
 * resolves the active workspace once (every route is workspace-scoped), fetches
 * the caller's visible Spaces, and tracks the active-space id — persisted per
 * workspace in localStorage, defaulting to the `ALL_SPACE_ID` sentinel ("All" =
 * no filter). `activeSpace` is the resolved `SpaceView`, or null for "All".
 *
 * It re-probes on the `'spaces:changed'` event (a CRUD in the manage modal
 * dispatches it via `useSpaces`) and on tab focus, mirroring `useAgentInbox`'s
 * ambient pending-count probe. It is resilient by design: a failed Spaces fetch
 * degrades to just "All" (the switcher stays usable) and only a 401 redirects.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, fetchMyWorkspaces, type MyWorkspace } from '@/lib/api';
import { pickActiveWorkspace } from '@/lib/workspace';
import { listSpaces, type SpaceView } from '@/lib/spacesApi';
import {
  ALL_SPACE_ID,
  readStoredActiveSpaceId,
  writeStoredActiveSpaceId,
  SPACES_CHANGED_EVENT,
} from '@/lib/activeSpace';

export type ActiveSpaceLoad = 'loading' | 'ready' | 'error';

export interface ActiveSpaceState {
  /** The workspace Spaces are scoped to (null = caller has no membership). */
  workspace: MyWorkspace | null;
  /** The caller's visible Spaces (personal + team), as returned by the backend. */
  spaces: SpaceView[];
  load: ActiveSpaceLoad;
  error: string | null;
  /** The active-space id; `ALL_SPACE_ID` ("all") means no filter. */
  activeSpaceId: string;
  setActiveSpaceId: (id: string) => void;
  /** The resolved active Space, or null when "All" (or not found → treated as All). */
  activeSpace: SpaceView | null;
  /** Re-fetch the Spaces list (silent — no skeleton flash). */
  refresh: () => Promise<void>;
}

/** Inert default so `useActiveSpace` never throws if read outside the provider. */
const DEFAULT_STATE: ActiveSpaceState = {
  workspace: null,
  spaces: [],
  load: 'loading',
  error: null,
  activeSpaceId: ALL_SPACE_ID,
  setActiveSpaceId: () => {},
  activeSpace: null,
  refresh: async () => {},
};

const ActiveSpaceContext = createContext<ActiveSpaceState>(DEFAULT_STATE);

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function ActiveSpaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<MyWorkspace | null>(null);
  const [spaces, setSpaces] = useState<SpaceView[]>([]);
  const [load, setLoad] = useState<ActiveSpaceLoad>('loading');
  const [error, setError] = useState<string | null>(null);
  // Starts at the "All" sentinel (SSR-safe); hydrated from storage once the
  // workspace resolves, so there is no server/client mismatch on first paint.
  const [activeSpaceId, setActiveSpaceIdState] = useState<string>(ALL_SPACE_ID);

  // A 401 anywhere means the session lapsed — bounce to login (suite pattern).
  const guard401 = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/auth/login');
        return true;
      }
      return false;
    },
    [router],
  );

  const fetchFor = useCallback(
    async (ws: MyWorkspace, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const res = await listSpaces(ws.workspace_id);
        setSpaces(res.items);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (guard401(err)) return;
        // Ambient: keep the switcher usable as "All" even if Spaces can't load.
        setSpaces([]);
        setError(messageOf(err, 'Could not load your spaces.'));
        setLoad('error');
      }
    },
    [guard401],
  );

  // Resolve the active workspace once, hydrate the stored id, then load Spaces.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ws = pickActiveWorkspace(await fetchMyWorkspaces());
        if (!alive) return;
        setWorkspace(ws);
        if (!ws) {
          setLoad('ready');
          return;
        }
        setActiveSpaceIdState(readStoredActiveSpaceId(ws.workspace_id));
        await fetchFor(ws);
      } catch (err) {
        if (!alive) return;
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not resolve your workspace.'));
        setLoad('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchFor, guard401]);

  const refresh = useCallback(async () => {
    if (workspace) await fetchFor(workspace, true);
  }, [workspace, fetchFor]);

  // Re-probe when a CRUD elsewhere changes the Spaces set, or on tab focus —
  // so the switcher + scoped pages never go stale (mirrors useAgentInbox).
  useEffect(() => {
    const onChanged = () => void refresh();
    window.addEventListener(SPACES_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onChanged);
    return () => {
      window.removeEventListener(SPACES_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onChanged);
    };
  }, [refresh]);

  const setActiveSpaceId = useCallback(
    (id: string) => {
      setActiveSpaceIdState(id);
      if (workspace) writeStoredActiveSpaceId(workspace.workspace_id, id);
    },
    [workspace],
  );

  // Reconcile: if the active Space vanished (deleted, or no longer visible),
  // fall back to "All" rather than silently filtering to nothing.
  useEffect(() => {
    if (activeSpaceId === ALL_SPACE_ID) return;
    if (load !== 'ready') return;
    if (!spaces.some((s) => s.id === activeSpaceId)) {
      setActiveSpaceId(ALL_SPACE_ID);
    }
  }, [activeSpaceId, spaces, load, setActiveSpaceId]);

  const activeSpace = useMemo(
    () =>
      activeSpaceId === ALL_SPACE_ID
        ? null
        : spaces.find((s) => s.id === activeSpaceId) ?? null,
    [activeSpaceId, spaces],
  );

  const value = useMemo<ActiveSpaceState>(
    () => ({
      workspace,
      spaces,
      load,
      error,
      activeSpaceId,
      setActiveSpaceId,
      activeSpace,
      refresh,
    }),
    [workspace, spaces, load, error, activeSpaceId, setActiveSpaceId, activeSpace, refresh],
  );

  return <ActiveSpaceContext.Provider value={value}>{children}</ActiveSpaceContext.Provider>;
}

/** Read the ambient active-Space state (safe inert default outside the provider). */
export function useActiveSpace(): ActiveSpaceState {
  return useContext(ActiveSpaceContext);
}
