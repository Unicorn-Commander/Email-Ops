'use client';

/**
 * Data layer for managing Spaces — the per-workspace registry of mailbox+agent
 * groupings shown in the manage modal.
 *
 * Shape mirrors `useAgents`: a `load` discriminator, an `error` string, a
 * `refresh()`, and the active-workspace resolution every route is scoped to.
 * Mutations (`create`, `update`, `remove`, `setMailboxes`, `setAgents`) refresh
 * the list on success and return a typed outcome so the modal can surface the
 * 400 / 403 / 409 inline. Each successful mutation also dispatches the
 * `'spaces:changed'` event (via `emitSpacesChanged`) so the ambient
 * `ActiveSpaceProvider` — which powers the Top-bar switcher + the scoped pages —
 * re-probes and stays in lockstep.
 *
 * The membership setters are REPLACE: they send the WHOLE id set.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type MyWorkspace } from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import {
  createSpace,
  deleteSpace,
  listSpaces,
  setSpaceAgents,
  setSpaceMailboxes,
  updateSpace,
  type CreateSpaceBody,
  type SpaceView,
  type UpdateSpaceBody,
} from '@/lib/spacesApi';
import { emitSpacesChanged } from '@/lib/activeSpace';

export type SpacesLoad = 'loading' | 'ready' | 'error';

/**
 * Result of a create/update/membership mutation — lets the modal show inline
 * feedback. `space` carries the refreshed projection on success (create/update/
 * membership return one; `remove` does not).
 */
export interface SpaceMutationOutcome {
  ok: boolean;
  error?: string;
  space?: SpaceView;
}

export interface UseSpaces {
  /** The workspace the registry is scoped to (null = caller has no membership). */
  workspace: MyWorkspace | null;
  /** The caller's visible Spaces for the active workspace. */
  items: SpaceView[];
  load: SpacesLoad;
  error: string | null;
  /** Re-fetch the Spaces. */
  refresh: () => Promise<void>;
  /** Create a Space. Refreshes on success; returns the created Space. */
  create: (body: CreateSpaceBody) => Promise<SpaceMutationOutcome>;
  /** Rename / recolor / re-scope a Space. Refreshes on success. */
  update: (id: string, body: UpdateSpaceBody) => Promise<SpaceMutationOutcome>;
  /** Delete a Space. Refreshes on success. */
  remove: (id: string) => Promise<SpaceMutationOutcome>;
  /** REPLACE the Space's mailbox membership. Refreshes on success. */
  setMailboxes: (id: string, mailboxIds: string[]) => Promise<SpaceMutationOutcome>;
  /** REPLACE the Space's agent membership. Refreshes on success. */
  setAgents: (id: string, agentIds: string[]) => Promise<SpaceMutationOutcome>;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function useSpaces(): UseSpaces {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<MyWorkspace | null>(null);
  const [items, setItems] = useState<SpaceView[]>([]);
  const [load, setLoad] = useState<SpacesLoad>('loading');
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

  /** Fetch the Spaces. `silent` skips the skeleton flash on a post-mutation refresh. */
  const fetchFor = useCallback(
    async (ws: MyWorkspace, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const res = await listSpaces(ws.workspace_id);
        setItems(res.items);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load your spaces.'));
        setLoad('error');
      }
    },
    [guard401],
  );

  // Consume the active org (`ActiveWorkspaceProvider`) so the registry re-scopes
  // when it switches; keyed on the workspace id to avoid refetch churn.
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;

  useEffect(() => {
    if (!activeWorkspace) {
      setWorkspace(null);
      // Settle only once the org layer resolved (no membership → no spaces).
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    setWorkspace(activeWorkspace);
    void fetchFor(activeWorkspace);
  }, [activeWorkspaceId, workspaceLoad, fetchFor]);

  const refresh = useCallback(async () => {
    if (workspace) await fetchFor(workspace, true);
  }, [workspace, fetchFor]);

  /** Shared mutation runner: call → silent refresh → nudge ambient surfaces. */
  const run = useCallback(
    async (
      op: (ws: MyWorkspace) => Promise<SpaceView | void>,
      fallback: string,
    ): Promise<SpaceMutationOutcome> => {
      if (!workspace) return { ok: false, error: 'No active workspace.' };
      try {
        const space = await op(workspace);
        await fetchFor(workspace, true);
        emitSpacesChanged();
        return { ok: true, ...(space ? { space } : {}) };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, fallback) };
      }
    },
    [workspace, fetchFor, guard401],
  );

  const create = useCallback(
    (body: CreateSpaceBody) =>
      run((ws) => createSpace(ws.workspace_id, body), 'Could not create the space.'),
    [run],
  );

  const update = useCallback(
    (id: string, body: UpdateSpaceBody) =>
      run((ws) => updateSpace(ws.workspace_id, id, body), 'Could not update the space.'),
    [run],
  );

  const remove = useCallback(
    (id: string) =>
      run(async (ws) => {
        await deleteSpace(ws.workspace_id, id);
      }, 'Could not delete the space.'),
    [run],
  );

  const setMailboxes = useCallback(
    (id: string, mailboxIds: string[]) =>
      run(
        (ws) => setSpaceMailboxes(ws.workspace_id, id, mailboxIds),
        'Could not update the space mailboxes.',
      ),
    [run],
  );

  const setAgents = useCallback(
    (id: string, agentIds: string[]) =>
      run(
        (ws) => setSpaceAgents(ws.workspace_id, id, agentIds),
        'Could not update the space agents.',
      ),
    [run],
  );

  return {
    workspace,
    items,
    load,
    error,
    refresh,
    create,
    update,
    remove,
    setMailboxes,
    setAgents,
  };
}
