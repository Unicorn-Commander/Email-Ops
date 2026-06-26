'use client';

/**
 * Ambient active-Space state, shared by the Top-bar switcher AND the scoped
 * pages (`/mail`, `/agents`) so they all read the SAME active Space.
 *
 * It is a thin context mounted high in `AppShell` (inside `ActiveWorkspaceProvider`,
 * around `ProductChrome`): it CONSUMES the active org from `useActiveWorkspace()`
 * (Spaces live inside an org), fetches that org's visible Spaces, and tracks the
 * active-space id — persisted per workspace in localStorage, defaulting to the
 * `ALL_SPACE_ID` sentinel ("All" = no filter). It re-scopes whenever the org
 * switches. `activeSpace` is the resolved `SpaceView`, or null for "All".
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
import { ApiError, type MyWorkspace } from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
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
  // Spaces live inside an org — consume the active org instead of resolving our
  // own, so the Space scope re-derives whenever the org switches.
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;

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
    async (wsId: string, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const res = await listSpaces(wsId);
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

  // Re-scope to the active org: hydrate the stored active-space id, then load the
  // Spaces. Re-runs whenever the org switches (keyed on the workspace id).
  useEffect(() => {
    if (!workspaceId) {
      setSpaces([]);
      setActiveSpaceIdState(ALL_SPACE_ID);
      // Settle only once the org layer resolved (no membership → no spaces).
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    setActiveSpaceIdState(readStoredActiveSpaceId(workspaceId));
    void fetchFor(workspaceId);
  }, [workspaceId, workspaceLoad, fetchFor]);

  const refresh = useCallback(async () => {
    if (workspaceId) await fetchFor(workspaceId, true);
  }, [workspaceId, fetchFor]);

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
      if (workspaceId) writeStoredActiveSpaceId(workspaceId, id);
    },
    [workspaceId],
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
      workspace: activeWorkspace,
      spaces,
      load,
      error,
      activeSpaceId,
      setActiveSpaceId,
      activeSpace,
      refresh,
    }),
    [activeWorkspace, spaces, load, error, activeSpaceId, setActiveSpaceId, activeSpace, refresh],
  );

  return <ActiveSpaceContext.Provider value={value}>{children}</ActiveSpaceContext.Provider>;
}

/** Read the ambient active-Space state (safe inert default outside the provider). */
export function useActiveSpace(): ActiveSpaceState {
  return useContext(ActiveSpaceContext);
}
