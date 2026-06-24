'use client';

/**
 * Data layer for the Agent-Inbox approval queue.
 *
 * This is the human-in-the-loop spine of the Agent Email Command Center: agents
 * stage outbound email (and mailbox-cleanup batches) into a per-workspace queue;
 * a human lists it here and approves (which SENDS / executes) or rejects (which
 * never sends). The backend owns the state machine + RLS + the entitlement gate
 * on approve — this hook is the typed browser client over those routes.
 *
 * Shape mirrors `useInboxStats`: a `load` discriminator, an `error` string, and
 * a `refresh()`. It additionally resolves the active workspace (every route is
 * workspace-scoped) and tracks the pending count independently so the queue's
 * tab badge stays correct even while viewing approved/rejected history.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  approveAgentInboxItem,
  fetchMyWorkspaces,
  listAgentInbox,
  rejectAgentInboxItem,
  ApiError,
  type AgentInboxItemView,
  type AgentInboxState,
  type MyWorkspace,
} from '@/lib/api';
import { pickActiveWorkspace } from '@/lib/workspace';

export type AgentInboxLoad = 'loading' | 'ready' | 'error';

/** Result of an approve/reject — lets the card show inline per-item feedback. */
export interface ReviewOutcome {
  ok: boolean;
  error?: string;
}

export interface UseAgentInbox {
  /** The workspace the queue is scoped to (null = caller has no membership). */
  workspace: MyWorkspace | null;
  /** Which slice is shown. */
  state: AgentInboxState;
  setState: (next: AgentInboxState) => void;
  /** Items for the active `state`. */
  items: AgentInboxItemView[];
  /** Count of PENDING items, regardless of the active `state` (tab badge). */
  pendingCount: number;
  load: AgentInboxLoad;
  error: string | null;
  /** Re-fetch the active slice + the pending count. */
  refresh: () => Promise<void>;
  /** Approve (EMAIL → sends; CLEANUP → executes the batch). Refreshes on success. */
  approve: (itemId: string, note?: string) => Promise<ReviewOutcome>;
  /** Reject (never sends / never executes). Refreshes on success. */
  reject: (itemId: string, note?: string) => Promise<ReviewOutcome>;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function useAgentInbox(): UseAgentInbox {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<MyWorkspace | null>(null);
  const [state, setState] = useState<AgentInboxState>('pending');
  const [items, setItems] = useState<AgentInboxItemView[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [load, setLoad] = useState<AgentInboxLoad>('loading');
  const [error, setError] = useState<string | null>(null);

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

  /**
   * Fetch the active slice (+ the pending count). `silent` skips the skeleton
   * flash so a post-action refresh stays calm.
   */
  const fetchFor = useCallback(
    async (ws: MyWorkspace, slice: AgentInboxState, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const [active, pending] = await Promise.all([
          listAgentInbox(ws.workspace_id, slice),
          slice === 'pending'
            ? Promise.resolve(null)
            : listAgentInbox(ws.workspace_id, 'pending'),
        ]);
        setItems(active.items);
        setPendingCount(slice === 'pending' ? active.count : (pending?.count ?? 0));
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load the agent inbox.'));
        setLoad('error');
      }
    },
    [guard401],
  );

  // Resolve the active workspace once, then load the default (pending) slice.
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
        await fetchFor(ws, 'pending');
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
    if (workspace) await fetchFor(workspace, state);
  }, [workspace, state, fetchFor]);

  const changeState = useCallback(
    (next: AgentInboxState) => {
      setState(next);
      if (workspace) void fetchFor(workspace, next);
    },
    [workspace, fetchFor],
  );

  const act = useCallback(
    async (
      kind: 'approve' | 'reject',
      itemId: string,
      note?: string,
    ): Promise<ReviewOutcome> => {
      if (!workspace) return { ok: false, error: 'No active workspace.' };
      try {
        if (kind === 'approve') {
          await approveAgentInboxItem(workspace.workspace_id, itemId, note);
        } else {
          await rejectAgentInboxItem(workspace.workspace_id, itemId, note);
        }
        // Silent refresh so the decided item slides out without a skeleton flash.
        await fetchFor(workspace, state, true);
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, `Could not ${kind} this item.`) };
      }
    },
    [workspace, state, fetchFor, guard401],
  );

  const approve = useCallback(
    (itemId: string, note?: string) => act('approve', itemId, note),
    [act],
  );
  const reject = useCallback(
    (itemId: string, note?: string) => act('reject', itemId, note),
    [act],
  );

  return {
    workspace,
    state,
    setState: changeState,
    items,
    pendingCount,
    load,
    error,
    refresh,
    approve,
    reject,
  };
}

/**
 * Lightweight pending-count probe for ambient chrome (the nav badge). Resolves
 * the active workspace and reads the pending count once; resilient by design —
 * returns 0 on any failure and never redirects (it must never hijack a page).
 */
export function useAgentInboxPendingCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ws = pickActiveWorkspace(await fetchMyWorkspaces());
        if (!ws) return;
        const res = await listAgentInbox(ws.workspace_id, 'pending');
        if (alive) setCount(res.count);
      } catch {
        /* ambient — stay at 0 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return count;
}
