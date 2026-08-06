'use client';

/**
 * The workspace kill switch, backed by the real backend (was a cosmetic toggle).
 *
 * Resolves the active workspace, reads the current pause state on mount, and
 * exposes a `setPaused` that PUTs the change (optimistic, reverts on failure).
 * Ambient + resilient: any failure leaves the last known state and never throws.
 */

import { useCallback, useEffect, useState } from 'react';
import { getAgentControls, setAgentControls } from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';

export interface UseAgentControls {
  agentsPaused: boolean;
  busy: boolean;
  setPaused: (next: boolean) => void;
  toggle: () => void;
}

export function useAgentControls(): UseAgentControls {
  // Consume the active org so the kill switch reads/writes the right tenant and
  // re-reads when the org switches (mirrors the rest of the chrome).
  const { activeWorkspace } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;
  const [agentsPaused, setAgentsPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setAgentsPaused(false);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await getAgentControls(activeWorkspaceId);
        if (alive) setAgentsPaused(res.agents_paused);
      } catch {
        /* ambient — leave the toggle at its default */
      }
    })();
    return () => {
      alive = false;
    };
  }, [activeWorkspaceId]);

  const setPaused = useCallback(
    (next: boolean) => {
      // Ignore a toggle fired before the workspace resolves — flipping the UI
      // without a PUT would leave it out of sync with the backend.
      if (!activeWorkspaceId) return;
      const prev = agentsPaused;
      setAgentsPaused(next); // optimistic
      setBusy(true);
      void (async () => {
        try {
          const res = await setAgentControls(activeWorkspaceId, next);
          setAgentsPaused(res.agents_paused);
        } catch {
          setAgentsPaused(prev); // revert on failure
        } finally {
          setBusy(false);
        }
      })();
    },
    [agentsPaused, activeWorkspaceId],
  );

  const toggle = useCallback(() => setPaused(!agentsPaused), [agentsPaused, setPaused]);

  return { agentsPaused, busy, setPaused, toggle };
}
