'use client';

/**
 * Data layer for the Agents view — the per-workspace agent fleet registry.
 *
 * Agents are first-class identities that draft (and, per their autonomy level,
 * send) mail from an assigned mailbox. This view is the human-facing roster:
 * list the fleet, create an agent, and edit its mailbox / autonomy / active
 * flag. The backend owns RLS + the unique-key/mailbox-in-workspace validation —
 * this hook is the typed browser client over those routes.
 *
 * Shape mirrors `useAgentInbox`: a `load` discriminator, an `error` string, a
 * `refresh()`, and the active-workspace resolution every route is scoped to.
 * Mutations (`create`, `update`) refresh on success and return a typed outcome
 * so the page can surface the 409/400 inline.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createAgent,
  listAgents,
  updateAgent,
  ApiError,
  type AgentView,
  type CreateAgentBody,
  type MyWorkspace,
  type UpdateAgentBody,
} from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';

export type AgentsLoad = 'loading' | 'ready' | 'error';

/** Result of a create/update — lets the caller show inline feedback. */
export interface AgentMutationOutcome {
  ok: boolean;
  error?: string;
}

export interface UseAgents {
  /** The workspace the fleet is scoped to (null = caller has no membership). */
  workspace: MyWorkspace | null;
  /** The agent fleet for the active workspace. */
  items: AgentView[];
  load: AgentsLoad;
  error: string | null;
  /** Re-fetch the fleet. */
  refresh: () => Promise<void>;
  /** Create an agent. Refreshes on success. */
  create: (body: CreateAgentBody) => Promise<AgentMutationOutcome>;
  /** Update an agent (mailbox / autonomy / active / …). Refreshes on success. */
  update: (id: string, body: UpdateAgentBody) => Promise<AgentMutationOutcome>;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function useAgents(): UseAgents {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<MyWorkspace | null>(null);
  const [items, setItems] = useState<AgentView[]>([]);
  const [load, setLoad] = useState<AgentsLoad>('loading');
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
   * Fetch the fleet. `silent` skips the skeleton flash so a post-mutation
   * refresh stays calm.
   */
  const fetchFor = useCallback(
    async (ws: MyWorkspace, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const res = await listAgents(ws.workspace_id);
        setItems(res.items);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load the agent fleet.'));
        setLoad('error');
      }
    },
    [guard401],
  );

  // Consume the active org (`ActiveWorkspaceProvider`) so the fleet re-scopes
  // when it switches; keyed on the workspace id to avoid refetch churn.
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;

  useEffect(() => {
    if (!activeWorkspace) {
      setWorkspace(null);
      // Settle only once the org layer resolved (no membership → empty fleet).
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    setWorkspace(activeWorkspace);
    void fetchFor(activeWorkspace);
  }, [activeWorkspaceId, workspaceLoad, fetchFor]);

  const refresh = useCallback(async () => {
    if (workspace) await fetchFor(workspace);
  }, [workspace, fetchFor]);

  const create = useCallback(
    async (body: CreateAgentBody): Promise<AgentMutationOutcome> => {
      if (!workspace) return { ok: false, error: 'No active workspace.' };
      try {
        await createAgent(workspace.workspace_id, body);
        // Silent refresh so the new agent appears without a skeleton flash.
        await fetchFor(workspace, true);
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not create the agent.') };
      }
    },
    [workspace, fetchFor, guard401],
  );

  const update = useCallback(
    async (id: string, body: UpdateAgentBody): Promise<AgentMutationOutcome> => {
      if (!workspace) return { ok: false, error: 'No active workspace.' };
      try {
        await updateAgent(workspace.workspace_id, id, body);
        await fetchFor(workspace, true);
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not update the agent.') };
      }
    },
    [workspace, fetchFor, guard401],
  );

  return {
    workspace,
    items,
    load,
    error,
    refresh,
    create,
    update,
  };
}
