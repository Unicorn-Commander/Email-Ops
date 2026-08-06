import { AgentActionKind, AgentInboxState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentControlsService, parseWindowDays } from './agent-controls.service';

/**
 * AgentControlsService unit tests: the kill-switch read/set (with the
 * PAUSED/RESUMED event recorded only on an actual change) and the activity-feed
 * mapping + limit clamp, over a mocked workspace tx.
 */
describe('AgentControlsService', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';
  const UID = 'uc-uid';

  function makeTx() {
    return {
      workspace: { findUnique: jest.fn(), update: jest.fn() },
      agentActionEvent: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
      threadDisposition: { count: jest.fn() },
      agentInboxItem: { count: jest.fn() },
    };
  }
  function svcOf(tx: ReturnType<typeof makeTx>) {
    const prisma = {
      withWorkspace: jest.fn((_w: string, _u: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    return new AgentControlsService(prisma);
  }

  it('getControls reads agentsPaused (defaults to false when unset)', async () => {
    const tx = makeTx();
    tx.workspace.findUnique.mockResolvedValue({ agentsPaused: true });
    expect(await svcOf(tx).getControls(WS, UID)).toEqual({ agents_paused: true });

    const tx2 = makeTx();
    tx2.workspace.findUnique.mockResolvedValue(null);
    expect(await svcOf(tx2).getControls(WS, UID)).toEqual({ agents_paused: false });
  });

  it('setControls flips the flag + records a PAUSED event on change', async () => {
    const tx = makeTx();
    tx.workspace.findUnique.mockResolvedValue({ agentsPaused: false });
    const out = await svcOf(tx).setControls(WS, UID, true);

    expect(out).toEqual({ agents_paused: true });
    expect(tx.workspace.update).toHaveBeenCalledWith({
      where: { id: WS },
      data: { agentsPaused: true },
    });
    expect(tx.agentActionEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: AgentActionKind.PAUSED, actorUcUid: UID }),
    });
  });

  it('setControls is a no-op (no update, no event) when the value is unchanged', async () => {
    const tx = makeTx();
    tx.workspace.findUnique.mockResolvedValue({ agentsPaused: true });
    await svcOf(tx).setControls(WS, UID, true);
    expect(tx.workspace.update).not.toHaveBeenCalled();
    expect(tx.agentActionEvent.create).not.toHaveBeenCalled();
  });

  it('listActivity maps rows to the wire shape and clamps the limit to 200', async () => {
    const tx = makeTx();
    tx.agentActionEvent.findMany.mockResolvedValue([
      {
        id: 'e1',
        kind: AgentActionKind.AUTONOMOUS_SEND,
        agentKey: 'customer-ops',
        messageId: 'm1',
        actorUcUid: null,
        detail: 'sent',
        createdAt: new Date('2026-06-24T00:00:00.000Z'),
      },
    ]);
    const items = await svcOf(tx).listActivity(WS, UID, 9999);

    expect(tx.agentActionEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
    expect(items[0]).toMatchObject({
      id: 'e1',
      kind: 'AUTONOMOUS_SEND',
      agent_key: 'customer-ops',
      message_id: 'm1',
      actor_uc_uid: null,
      detail: 'sent',
      created_at: '2026-06-24T00:00:00.000Z',
    });
  });

  // ── getMetrics: the real server-side rail metrics ─────────────────────────

  describe('getMetrics', () => {
    it('counts the real signals: agent-triaged threads, agent sends, pending', async () => {
      const tx = makeTx();
      tx.threadDisposition.count.mockResolvedValue(4);
      tx.agentActionEvent.count.mockResolvedValue(9);
      tx.agentInboxItem.count.mockResolvedValue(2);

      const out = await svcOf(tx).getMetrics(WS, UID, 7);

      expect(out).toEqual({ triaged: 4, sent: 9, awaiting: 2, window_days: 7 });

      // triaged = distinct threads an AGENT filed in the window (setByAgentKey set).
      expect(tx.threadDisposition.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          workspaceId: WS,
          setByAgentKey: { not: null },
          updatedAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      });
      // sent = AUTONOMOUS_SEND + APPROVED in the window.
      expect(tx.agentActionEvent.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          workspaceId: WS,
          kind: { in: [AgentActionKind.AUTONOMOUS_SEND, AgentActionKind.APPROVED] },
          createdAt: expect.objectContaining({ gte: expect.any(Date) }),
        }),
      });
      // awaiting = CURRENT pending items (not windowed) — the nav-badge value.
      expect(tx.agentInboxItem.count).toHaveBeenCalledWith({
        where: { workspaceId: WS, state: AgentInboxState.PENDING },
      });
    });

    it('every count carries an explicit workspaceId predicate (cross-tenant fence)', async () => {
      const tx = makeTx();
      tx.threadDisposition.count.mockResolvedValue(0);
      tx.agentActionEvent.count.mockResolvedValue(0);
      tx.agentInboxItem.count.mockResolvedValue(0);

      await svcOf(tx).getMetrics(WS, UID, 30);

      // RLS is inert under the owner role, so the explicit predicate is the real
      // tenant fence: a foreign workspace's rows can NEVER be counted here.
      for (const call of [
        tx.threadDisposition.count,
        tx.agentActionEvent.count,
        tx.agentInboxItem.count,
      ]) {
        expect(call).toHaveBeenCalledWith(
          expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS }) }),
        );
      }
    });

    it('is degrade-clean: returns zeros (never throws) when a query fails', async () => {
      const tx = makeTx();
      tx.threadDisposition.count.mockRejectedValue(new Error('db down'));
      tx.agentActionEvent.count.mockResolvedValue(3);
      tx.agentInboxItem.count.mockResolvedValue(1);

      const out = await svcOf(tx).getMetrics(WS, UID, 7);
      expect(out).toEqual({ triaged: 0, sent: 0, awaiting: 0, window_days: 7 });
    });

    it('clamps the window to 1–90 days', async () => {
      const tx = makeTx();
      tx.threadDisposition.count.mockResolvedValue(0);
      tx.agentActionEvent.count.mockResolvedValue(0);
      tx.agentInboxItem.count.mockResolvedValue(0);

      expect((await svcOf(tx).getMetrics(WS, UID, 9999)).window_days).toBe(90);
      expect((await svcOf(tx).getMetrics(WS, UID, 0)).window_days).toBe(7); // 0 → default
      expect((await svcOf(tx).getMetrics(WS, UID, -5)).window_days).toBe(1);
    });
  });

  describe('parseWindowDays', () => {
    it('parses "Nd" / bare-N, defaults + clamps', () => {
      expect(parseWindowDays('7d')).toBe(7);
      expect(parseWindowDays('30')).toBe(30);
      expect(parseWindowDays('  14d ')).toBe(14);
      expect(parseWindowDays(undefined)).toBe(7);
      expect(parseWindowDays('garbage')).toBe(7);
      expect(parseWindowDays('999d')).toBe(90);
      expect(parseWindowDays('0')).toBe(7);
    });
  });
});
