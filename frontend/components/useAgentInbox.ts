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
  listAgentInbox,
  rejectAgentInboxItem,
  ApiError,
  type AgentInboxItemView,
  type AgentInboxState,
  type ApproveOptions,
  type MyWorkspace,
} from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';

export type AgentInboxLoad = 'loading' | 'ready' | 'error';

/**
 * Which slice of the queue is shown. The wire knows pending/approved/rejected;
 * 'history' is a client-side view that merges approved + rejected newest-first
 * (the Wave-7 History tab) — the hook fans out both list calls for it.
 */
export type AgentInboxSlice = AgentInboxState | 'history';

/** When the decided slice(s) were reviewed, for the merged history ordering. */
function decidedAt(item: AgentInboxItemView): number {
  const iso = item.reviewed_at ?? item.created_at;
  const ts = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ts) ? 0 : ts;
}

/** Result of an approve/reject — lets the card show inline per-item feedback. */
export interface ReviewOutcome {
  ok: boolean;
  error?: string;
}

export interface UseAgentInbox {
  /** The workspace the queue is scoped to (null = caller has no membership). */
  workspace: MyWorkspace | null;
  /** Which slice is shown ('history' = approved + rejected merged). */
  state: AgentInboxSlice;
  setState: (next: AgentInboxSlice) => void;
  /** Items for the active `state`. */
  items: AgentInboxItemView[];
  /** Count of PENDING items, regardless of the active `state` (tab badge). */
  pendingCount: number;
  load: AgentInboxLoad;
  error: string | null;
  /** Re-fetch the active slice + the pending count. */
  refresh: () => Promise<void>;
  /**
   * Approve (EMAIL → sends; CLEANUP → executes the batch). Refreshes on
   * success. `opts.trustRecipients` rides along when the review UI surfaced
   * the first-contact trust choice.
   */
  approve: (itemId: string, note?: string, opts?: ApproveOptions) => Promise<ReviewOutcome>;
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
  const [state, setState] = useState<AgentInboxSlice>('pending');
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
    async (ws: MyWorkspace, slice: AgentInboxSlice, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        if (slice === 'history') {
          // The merged decided view: both decided slices + the pending count.
          const [approved, rejected, pending] = await Promise.all([
            listAgentInbox(ws.workspace_id, 'approved'),
            listAgentInbox(ws.workspace_id, 'rejected'),
            listAgentInbox(ws.workspace_id, 'pending'),
          ]);
          setItems(
            [...approved.items, ...rejected.items].sort((a, b) => decidedAt(b) - decidedAt(a)),
          );
          setPendingCount(pending.count);
        } else {
          const [active, pending] = await Promise.all([
            listAgentInbox(ws.workspace_id, slice),
            slice === 'pending'
              ? Promise.resolve(null)
              : listAgentInbox(ws.workspace_id, 'pending'),
          ]);
          setItems(active.items);
          setPendingCount(slice === 'pending' ? active.count : (pending?.count ?? 0));
        }
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

  // Consume the active org (`ActiveWorkspaceProvider`) so the queue re-scopes
  // when it switches; keyed on the workspace id to avoid refetch churn. A switch
  // resets the view to the default (pending) slice so the tab + items agree.
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;

  useEffect(() => {
    if (!activeWorkspace) {
      setWorkspace(null);
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    setWorkspace(activeWorkspace);
    setState('pending');
    void fetchFor(activeWorkspace, 'pending');
  }, [activeWorkspaceId, workspaceLoad, fetchFor]);

  const refresh = useCallback(async () => {
    if (workspace) await fetchFor(workspace, state);
  }, [workspace, state, fetchFor]);

  const changeState = useCallback(
    (next: AgentInboxSlice) => {
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
      opts?: ApproveOptions,
    ): Promise<ReviewOutcome> => {
      if (!workspace) return { ok: false, error: 'No active workspace.' };
      try {
        if (kind === 'approve') {
          await approveAgentInboxItem(workspace.workspace_id, itemId, note, opts);
        } else {
          await rejectAgentInboxItem(workspace.workspace_id, itemId, note);
        }
        // Silent refresh so the decided item slides out without a skeleton flash.
        await fetchFor(workspace, state, true);
        // Nudge ambient surfaces (the sidebar pending badge) to re-probe.
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('agent-inbox:changed'));
        }
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, `Could not ${kind} this item.`) };
      }
    },
    [workspace, state, fetchFor, guard401],
  );

  const approve = useCallback(
    (itemId: string, note?: string, opts?: ApproveOptions) => act('approve', itemId, note, opts),
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
  const { activeWorkspace } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setCount(0);
      return;
    }
    let alive = true;
    const probe = async () => {
      try {
        const res = await listAgentInbox(activeWorkspaceId, 'pending');
        if (alive) setCount(res.count);
      } catch {
        /* ambient — keep the last known count */
      }
    };
    void probe();
    // Re-probe when a decision changes the queue (approve/reject dispatches this)
    // or when the tab regains focus — so the sidebar badge never goes stale.
    const onChanged = () => void probe();
    window.addEventListener('agent-inbox:changed', onChanged);
    window.addEventListener('focus', onChanged);
    return () => {
      alive = false;
      window.removeEventListener('agent-inbox:changed', onChanged);
      window.removeEventListener('focus', onChanged);
    };
  }, [activeWorkspaceId]);

  return count;
}
