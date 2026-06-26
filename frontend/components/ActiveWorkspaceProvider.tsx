'use client';

/**
 * Ambient active-Organization state — the OUTER tenant every screen is scoped to.
 *
 * An Organization is the hard multi-tenant boundary (the existing `Workspace`);
 * Spaces, mailboxes, agents and the agent-inbox all live INSIDE the active org.
 * This thin context is mounted high in `AppShell` (OUTSIDE `ActiveSpaceProvider`,
 * which consumes it): it fetches the caller's orgs once, resolves the active org
 * — a stored valid id ?? the `is_default` one ?? the first — and tracks it,
 * persisted GLOBALLY in localStorage (`lib/activeWorkspace.ts`) so it survives
 * reloads.
 *
 * It re-probes on the `'workspace:changed'` event (a switch / create / accept
 * dispatches it) and on tab focus, mirroring `ActiveSpaceProvider`. It is
 * resilient by design: a failed orgs fetch degrades to an inline error (the rest
 * of the chrome stays usable) and only a 401 redirects. Switching the org here
 * re-scopes the WHOLE app, because `ActiveSpaceProvider` + every workspace-scoped
 * hook reads `activeWorkspace` from here and re-runs when its id changes.
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
import {
  emitWorkspaceChanged,
  readStoredActiveWorkspaceId,
  writeStoredActiveWorkspaceId,
  WORKSPACE_CHANGED_EVENT,
} from '@/lib/activeWorkspace';

export type ActiveWorkspaceLoad = 'loading' | 'ready' | 'error';

export interface ActiveWorkspaceState {
  /** Every org the caller is an active member of. */
  workspaces: MyWorkspace[];
  /** The resolved active org (null = the caller has no membership yet). */
  activeWorkspace: MyWorkspace | null;
  /** The active org id, or null when none is resolved. */
  activeWorkspaceId: string | null;
  /** Switch the active org — persists the choice + nudges ambient surfaces. */
  setActiveWorkspaceId: (id: string) => void;
  load: ActiveWorkspaceLoad;
  error: string | null;
  /** Re-fetch the orgs list (silent — no skeleton flash). */
  refresh: () => Promise<void>;
}

/** Inert default so `useActiveWorkspace` never throws if read outside the provider. */
const DEFAULT_STATE: ActiveWorkspaceState = {
  workspaces: [],
  activeWorkspace: null,
  activeWorkspaceId: null,
  setActiveWorkspaceId: () => {},
  load: 'loading',
  error: null,
  refresh: async () => {},
};

const ActiveWorkspaceContext = createContext<ActiveWorkspaceState>(DEFAULT_STATE);

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function ActiveWorkspaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<MyWorkspace[]>([]);
  const [load, setLoad] = useState<ActiveWorkspaceLoad>('loading');
  const [error, setError] = useState<string | null>(null);
  // Starts null (SSR-safe); hydrated from storage / defaults once the orgs land,
  // so there is no server/client mismatch on first paint.
  const [activeWorkspaceId, setActiveWorkspaceIdState] = useState<string | null>(null);

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

  /** Fetch the caller's orgs. `silent` skips the skeleton flash on a re-probe. */
  const fetchWorkspaces = useCallback(
    async (silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const list = await fetchMyWorkspaces();
        setWorkspaces(list);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (guard401(err)) return;
        // Resilient: keep the chrome usable; the switcher surfaces the error.
        setWorkspaces([]);
        setError(messageOf(err, 'Could not load your organizations.'));
        setLoad('error');
      }
    },
    [guard401],
  );

  // Fetch the caller's orgs once on mount.
  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  // Re-probe when a switch/create/accept fires the event, or on tab focus — so
  // the active org + its derived scopes never go stale (mirrors ActiveSpace).
  useEffect(() => {
    const onChanged = () => void fetchWorkspaces(true);
    window.addEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onChanged);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onChanged);
    };
  }, [fetchWorkspaces]);

  // Resolve / reconcile the active org once the list is ready: keep an explicit,
  // still-valid choice; else a stored valid id; else the default; else the first.
  // Hydrate-without-persist — only an explicit switch writes storage. This also
  // reconciles when the active org vanished (membership lost) on a later refresh.
  useEffect(() => {
    if (load !== 'ready') return;
    setActiveWorkspaceIdState((current) => {
      const isValid = (id: string | null) =>
        !!id && workspaces.some((w) => w.workspace_id === id);
      if (isValid(current)) return current;
      const stored = readStoredActiveWorkspaceId();
      if (isValid(stored)) return stored;
      return (
        workspaces.find((w) => w.is_default)?.workspace_id ?? workspaces[0]?.workspace_id ?? null
      );
    });
  }, [workspaces, load]);

  const setActiveWorkspaceId = useCallback((id: string) => {
    setActiveWorkspaceIdState(id);
    writeStoredActiveWorkspaceId(id);
    emitWorkspaceChanged();
  }, []);

  const refresh = useCallback(async () => {
    await fetchWorkspaces(true);
  }, [fetchWorkspaces]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.workspace_id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const value = useMemo<ActiveWorkspaceState>(
    () => ({
      workspaces,
      activeWorkspace,
      activeWorkspaceId,
      setActiveWorkspaceId,
      load,
      error,
      refresh,
    }),
    [workspaces, activeWorkspace, activeWorkspaceId, setActiveWorkspaceId, load, error, refresh],
  );

  return (
    <ActiveWorkspaceContext.Provider value={value}>{children}</ActiveWorkspaceContext.Provider>
  );
}

/** Read the ambient active-Organization state (safe inert default outside the provider). */
export function useActiveWorkspace(): ActiveWorkspaceState {
  return useContext(ActiveWorkspaceContext);
}
