'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  approveSendKit,
  getSendKit,
  listSendKits,
  rejectSendKit,
  type AgentSendKitView,
} from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';

export type SendKitsLoad = 'loading' | 'ready' | 'error';

export interface SendKitActionOutcome {
  ok: boolean;
  error?: string;
}

export interface UseSendKits {
  workspaceId: string | null;
  items: AgentSendKitView[];
  proposed: AgentSendKitView[];
  approved: AgentSendKitView[];
  humanSession: boolean;
  load: SendKitsLoad;
  error: string | null;
  refresh: () => Promise<void>;
  approve: (kit: AgentSendKitView) => Promise<SendKitActionOutcome>;
  reject: (kit: AgentSendKitView, note?: string) => Promise<SendKitActionOutcome>;
}

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function useSendKits(): UseSendKits {
  const router = useRouter();
  const { activeWorkspace } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;
  const [items, setItems] = useState<AgentSendKitView[]>([]);
  const [humanSession, setHumanSession] = useState(true);
  const [load, setLoad] = useState<SendKitsLoad>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setItems([]);
      setLoad('ready');
      setError(null);
      return;
    }
    setLoad('loading');
    try {
      const result = await listSendKits(workspaceId);
      const summaries = result.items ?? [];
      const proposedDetails = await Promise.all(
        summaries
          .filter((kit) => kit.state === 'PROPOSED')
          .map(async (kit) => {
            try {
              return await getSendKit(workspaceId, kit.kit_id);
            } catch {
              return kit;
            }
          }),
      );
      const detailById = new Map(proposedDetails.map((kit) => [kit.kit_id, kit]));
      setItems(summaries.map((kit) => detailById.get(kit.kit_id) ?? kit));
      setHumanSession(result.human_session !== false);
      setError(null);
      setLoad('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/auth/login');
        return;
      }
      setError(messageOf(err, 'Could not load send kits.'));
      setLoad('error');
    }
  }, [router, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (kind: 'approve' | 'reject', kit: AgentSendKitView, note?: string): Promise<SendKitActionOutcome> => {
      if (!workspaceId) return { ok: false, error: 'No active workspace.' };
      try {
        if (kind === 'approve') {
          await approveSendKit(workspaceId, kit.kit_id, kit.template_sha256);
        } else {
          await rejectSendKit(workspaceId, kit.kit_id, note);
        }
        await refresh();
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('agent-inbox:changed'));
        return { ok: true };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace('/auth/login');
          return { ok: false, error: 'Session expired.' };
        }
        return { ok: false, error: messageOf(err, `Could not ${kind} this send kit.`) };
      }
    },
    [refresh, router, workspaceId],
  );

  return {
    workspaceId,
    items,
    proposed: items.filter((kit) => kit.state === 'PROPOSED'),
    approved: items.filter((kit) => kit.state === 'APPROVED'),
    humanSession,
    load,
    error,
    refresh,
    approve: (kit) => act('approve', kit),
    reject: (kit, note) => act('reject', kit, note),
  };
}
