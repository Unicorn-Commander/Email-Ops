'use client';

/**
 * Data layer for the Auto-sent audit lane (Wave 7).
 *
 * Policy-auto-sent agent mail left the building WITHOUT a human approving each
 * message — this hook lists it newest-first so a human can review what went out
 * after the fact (and revoke a correspondent's trust if something looks off).
 *
 * Shape mirrors `useAgentInbox`: a `load` discriminator + `error` + `refresh`.
 * One extra state — 'absent' — marks a pre-Wave-7 backend (404/501 from the
 * endpoint): the tab renders an honest "not available yet" instead of an error.
 */

import { useCallback, useEffect, useState } from 'react';
import { listAutoSent, ApiError, type AutoSentItemView } from '@/lib/api';

export type AutoSentLoad = 'loading' | 'ready' | 'error' | 'absent';

export interface UseAutoSent {
  items: AutoSentItemView[];
  load: AutoSentLoad;
  error: string | null;
  refresh: () => Promise<void>;
}

function endpointMissing(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

export function useAutoSent(workspaceId: string | null): UseAutoSent {
  const [items, setItems] = useState<AutoSentItemView[]>([]);
  const [load, setLoad] = useState<AutoSentLoad>('loading');
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (ws: string, silent = false) => {
    if (!silent) setLoad('loading');
    try {
      const res = await listAutoSent(ws);
      // Newest-first regardless of server ordering (it's an audit feed).
      setItems(
        [...res.items].sort(
          (a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''),
        ),
      );
      setError(null);
      setLoad('ready');
    } catch (err) {
      if (endpointMissing(err)) {
        setItems([]);
        setError(null);
        setLoad('absent');
        return;
      }
      setError(
        err instanceof Error ? err.message : 'Could not load the auto-sent audit list.',
      );
      setLoad('error');
    }
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setItems([]);
      setLoad('loading');
      return;
    }
    void fetchOnce(workspaceId);
  }, [workspaceId, fetchOnce]);

  const refresh = useCallback(async () => {
    if (workspaceId) await fetchOnce(workspaceId);
  }, [workspaceId, fetchOnce]);

  return { items, load, error, refresh };
}
