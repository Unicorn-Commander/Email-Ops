import { AgentActionKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentControlsService } from './agent-controls.service';

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
      agentActionEvent: { create: jest.fn(), findMany: jest.fn() },
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
});
