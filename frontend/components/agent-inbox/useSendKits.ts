'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  approveSendKit,
  extendSendKit,
  getSendKit,
  listSendKits,
  reproposeSendKit,
  returnSendKitToAgent,
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
  expired: AgentSendKitView[];
  returned: AgentSendKitView[];
  superseded: AgentSendKitView[];
  humanSession: boolean;
  load: SendKitsLoad;
  error: string | null;
  refresh: () => Promise<void>;
  approve: (kit: AgentSendKitView) => Promise<SendKitActionOutcome>;
  reject: (kit: AgentSendKitView, note?: string) => Promise<SendKitActionOutcome>;
  extend: (kit: AgentSendKitView, expiresAt: string) => Promise<SendKitActionOutcome>;
  repropose: (kit: AgentSendKitView, expiresAt: string) => Promise<SendKitActionOutcome>;
  returnToAgent: (kit: AgentSendKitView, note: string) => Promise<SendKitActionOutcome>;
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
          .filter((kit) => ['PROPOSED', 'EXPIRED', 'RETURNED'].includes(kit.state))
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
    async (
      kind: 'approve' | 'reject' | 'extend' | 'repropose' | 'return',
      kit: AgentSendKitView,
      value?: string,
    ): Promise<SendKitActionOutcome> => {
      if (!workspaceId) return { ok: false, error: 'No active workspace.' };
      try {
        if (kind === 'approve') {
          await approveSendKit(workspaceId, kit.kit_id, kit.template_sha256);
        } else if (kind === 'reject') {
          await rejectSendKit(workspaceId, kit.kit_id, value);
        } else if (kind === 'extend') {
          await extendSendKit(workspaceId, kit.kit_id, value ?? '', kit.template_sha256);
        } else if (kind === 'repropose') {
          await reproposeSendKit(workspaceId, kit.kit_id, value ?? '');
        } else {
          await returnSendKitToAgent(workspaceId, kit.kit_id, value ?? '');
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
    expired: items.filter((kit) => kit.state === 'EXPIRED'),
    returned: items.filter((kit) => kit.state === 'RETURNED'),
    superseded: items.filter((kit) => kit.state === 'SUPERSEDED'),
    humanSession,
    load,
    error,
    refresh,
    approve: (kit) => act('approve', kit),
    reject: (kit, note) => act('reject', kit, note),
    extend: (kit, expiresAt) => act('extend', kit, expiresAt),
    repropose: (kit, expiresAt) => act('repropose', kit, expiresAt),
    returnToAgent: (kit, note) => act('return', kit, note),
  };
}
