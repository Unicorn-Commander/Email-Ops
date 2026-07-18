'use client';

/**
 * Ambient active-Space state, shared by the Top-bar switcher AND the scoped
 * pages (`/mail`, `/agents`) so they all read the SAME active Space.
 *
 * It is a thin context mounted high in `AppShell` (inside `ActiveWorkspaceProvider`,
 * around `ProductChrome`): it CONSUMES the active org from `useActiveWorkspace()`
 * (Spaces live inside an org), fetches that org's visible Spaces, and tracks the
 * active-space id — persisted per workspace in localStorage, defaulting to the
 * `ALL_SPACE_ID` sentinel ("All inboxes" = no filter). It re-scopes whenever the
 * org switches. `activeSpace` is the resolved `SpaceView`, or null for "All".
 *
 * CANONICAL pseudo-spaces (`lib/activeSpace.ts`): besides real Spaces the active
 * id may be `MY_MAIL_SPACE_ID` ('__mine__') or `AGENTS_SPACE_ID` ('__agents__').
 * The provider resolves those into a SYNTHETIC `SpaceView` whose mailbox/agent id
 * sets are computed from a lightweight per-workspace roster (`listMailMailboxes`
 * + `listAgents`, the same registry reads the manage modal uses) by owner_kind:
 * "My mail" = HUMAN/SHARED mailboxes (no agents); "Agents" = AGENT mailboxes +
 * the whole fleet. Consumers keep filtering on `activeSpace.mailbox_ids` /
 * `.agent_ids` untouched. Until the roster has loaded for the workspace (or if it
 * never can), a canonical id resolves to null — i.e. it FAILS OPEN to "All"
 * rather than fabricating an empty inbox; the id (and switcher label) is kept.
 *
 * It re-probes on the `'spaces:changed'` event (a CRUD in the manage modal
 * dispatches it via `useSpaces`) and on tab focus, mirroring `useAgentInbox`'s
 * ambient pending-count probe. It is resilient by design: a failed Spaces fetch
 * degrades to just "All" (the switcher stays usable), a failed roster fetch keeps
 * the last snapshot, and only a 401 redirects.
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
import { ApiError, listAgents, type AgentView, type MyWorkspace } from '@/lib/api';
import { listMailMailboxes, type MailboxPick } from '@/lib/mailApi';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { listSpaces, type SpaceView } from '@/lib/spacesApi';
import {
  AGENTS_SPACE_ID,
  ALL_SPACE_ID,
  MY_MAIL_SPACE_ID,
  isCanonicalSpaceId,
  normalizeSpaceId,
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
  /**
   * The active-space id — a real Space id or a canonical one: `ALL_SPACE_ID`
   * ("all" = no filter), `MY_MAIL_SPACE_ID` ('__mine__'), `AGENTS_SPACE_ID`
   * ('__agents__'). Always stored normalized ('__all__' collapses to "all").
   */
  activeSpaceId: string;
  /** Set (and persist) the active space. Accepts real + canonical ids ('__all__' alias included). */
  setActiveSpaceId: (id: string) => void;
  /**
   * The resolved active Space, or null when "All" (or not found → treated as
   * All). A canonical id resolves to a SYNTHETIC SpaceView with computed
   * mailbox_ids/agent_ids — null only while the roster hasn't loaded (fail-open).
   */
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

/**
 * The per-workspace roster the canonical pseudo-spaces are computed from.
 * `null` = not loaded yet for this workspace (canonical ids then fail open to "All").
 */
interface CanonicalRoster {
  mailboxes: MailboxPick[];
  agents: AgentView[];
}

/**
 * Resolve a canonical id into its synthetic `SpaceView` (null while the roster is
 * missing — fail open, never fabricate an empty inbox). "My mail" is every
 * non-AGENT mailbox (HUMAN + SHARED, which includes Gmail/M365-connected boxes)
 * and no agents; "Agents" is the AGENT mailboxes + the whole fleet. The negative
 * sort_orders are inert (canonical rows are pinned by the switcher, not sorted).
 */
function resolveCanonicalSpace(id: string, roster: CanonicalRoster | null): SpaceView | null {
  if (!roster) return null;
  if (id === MY_MAIL_SPACE_ID) {
    return {
      id: MY_MAIL_SPACE_ID,
      name: 'My mail',
      visibility: 'personal',
      color: null,
      icon: null,
      sort_order: -2,
      mailbox_ids: roster.mailboxes.filter((m) => m.owner_kind !== 'AGENT').map((m) => m.id),
      agent_ids: [],
    };
  }
  if (id === AGENTS_SPACE_ID) {
    return {
      id: AGENTS_SPACE_ID,
      name: 'Agents',
      visibility: 'personal',
      color: null,
      icon: null,
      sort_order: -1,
      mailbox_ids: roster.mailboxes.filter((m) => m.owner_kind === 'AGENT').map((m) => m.id),
      agent_ids: roster.agents.map((a) => a.id),
    };
  }
  return null;
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
  // The mailbox+agent roster the canonical pseudo-spaces resolve against —
  // reset on org switch (ids must never leak across workspaces).
  const [roster, setRoster] = useState<CanonicalRoster | null>(null);

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

  // The roster probe behind the canonical pseudo-spaces. Silent + best-effort:
  // a failure keeps the last snapshot (or null → canonical ids fail open to
  // "All") so a hiccup can never make "My mail" LOOK empty; only a 401 redirects.
  const fetchRoster = useCallback(
    async (wsId: string) => {
      try {
        const [mailboxes, agents] = await Promise.all([listMailMailboxes(wsId), listAgents(wsId)]);
        setRoster({ mailboxes: mailboxes.items, agents: agents.items });
      } catch (err) {
        if (guard401(err)) return;
        // Ambient: keep whatever snapshot we have.
      }
    },
    [guard401],
  );

  // Re-scope to the active org: hydrate the stored active-space id, then load the
  // Spaces + the canonical roster. Re-runs whenever the org switches (keyed on
  // the workspace id); the roster resets FIRST so ids never leak across orgs.
  useEffect(() => {
    if (!workspaceId) {
      setSpaces([]);
      setRoster(null);
      setActiveSpaceIdState(ALL_SPACE_ID);
      // Settle only once the org layer resolved (no membership → no spaces).
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    setRoster(null);
    setActiveSpaceIdState(readStoredActiveSpaceId(workspaceId));
    void fetchFor(workspaceId);
    void fetchRoster(workspaceId);
  }, [workspaceId, workspaceLoad, fetchFor, fetchRoster]);

  const refresh = useCallback(async () => {
    if (workspaceId) await Promise.all([fetchFor(workspaceId, true), fetchRoster(workspaceId)]);
  }, [workspaceId, fetchFor, fetchRoster]);

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
      // Normalize so '__all__' (the canonical-trio alias — e.g. from MCP
      // ui_switch_space) collapses onto the stored "all" sentinel.
      const normalized = normalizeSpaceId(id);
      setActiveSpaceIdState(normalized);
      if (workspaceId) writeStoredActiveSpaceId(workspaceId, normalized);
    },
    [workspaceId],
  );

  // Reconcile: if the active REAL Space vanished (deleted, or no longer
  // visible), fall back to "All" rather than silently filtering to nothing.
  // Canonical ids are client-only — always valid, never reconciled away.
  useEffect(() => {
    if (isCanonicalSpaceId(activeSpaceId)) return;
    if (load !== 'ready') return;
    if (!spaces.some((s) => s.id === activeSpaceId)) {
      setActiveSpaceId(ALL_SPACE_ID);
    }
  }, [activeSpaceId, spaces, load, setActiveSpaceId]);

  const activeSpace = useMemo(() => {
    if (activeSpaceId === ALL_SPACE_ID) return null;
    if (isCanonicalSpaceId(activeSpaceId)) return resolveCanonicalSpace(activeSpaceId, roster);
    return spaces.find((s) => s.id === activeSpaceId) ?? null;
  }, [activeSpaceId, spaces, roster]);

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
