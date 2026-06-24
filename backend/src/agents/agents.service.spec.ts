import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgentAutonomyLevel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AgentsService } from './agents.service';

/**
 * AgentsService unit tests: the registry logic over a mocked workspace tx —
 * field mapping + autonomy default, the view projection (mailbox address +
 * pending count), the duplicate-key → 409 and foreign-mailbox → 400 guards, and
 * the partial-patch semantics (undefined leaves, null clears). The RLS chokepoint
 * itself (withWorkspace) is exercised elsewhere; here we drive the callback.
 */
describe('AgentsService', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';
  const UID = 'kc-sub-aaron';

  function agentRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'agent-1',
      workspaceId: WS,
      key: 'customer-ops',
      displayName: 'Customer-Ops',
      description: null,
      mailboxAccountId: null,
      autonomyLevel: AgentAutonomyLevel.L1_APPROVE_TO_SEND,
      recipientPolicy: null,
      active: true,
      createdAt: new Date('2026-06-23T00:00:00.000Z'),
      updatedAt: new Date('2026-06-23T00:00:00.000Z'),
      ...over,
    };
  }

  // A fake transaction client with just the methods the service touches.
  function makeTx() {
    return {
      agent: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      mailboxAccount: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      agentInboxItem: {
        groupBy: jest.fn(),
        count: jest.fn(),
      },
    };
  }

  function makeService(tx: ReturnType<typeof makeTx>) {
    const prisma = {
      withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
    } as unknown as PrismaService;
    return new AgentsService(prisma);
  }

  it('createAgent defaults autonomy to L1 and projects pending_count + null mailbox', async () => {
    const tx = makeTx();
    tx.agent.create.mockResolvedValue(agentRow());
    tx.agentInboxItem.count.mockResolvedValue(2);
    const svc = makeService(tx);

    const view = await svc.createAgent(WS, UID, { key: 'customer-ops', displayName: 'Customer-Ops' });

    expect(tx.agent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WS,
        key: 'customer-ops',
        displayName: 'Customer-Ops',
        autonomyLevel: AgentAutonomyLevel.L1_APPROVE_TO_SEND,
      }),
    });
    expect(view).toMatchObject({
      id: 'agent-1',
      key: 'customer-ops',
      autonomy_level: 'L1_APPROVE_TO_SEND',
      mailbox_address: null,
      pending_count: 2,
      active: true,
    });
  });

  it('createAgent maps a duplicate key (P2002) to 409 Conflict', async () => {
    const tx = makeTx();
    tx.agent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' }),
    );
    const svc = makeService(tx);
    await expect(
      svc.createAgent(WS, UID, { key: 'customer-ops', displayName: 'X' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('createAgent rejects a mailbox outside the workspace with 400 (and never inserts)', async () => {
    const tx = makeTx();
    tx.mailboxAccount.findFirst.mockResolvedValue(null); // not ours
    const svc = makeService(tx);
    await expect(
      svc.createAgent(WS, UID, { key: 'k', displayName: 'K', mailboxAccountId: 'mb-foreign' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.agent.create).not.toHaveBeenCalled();
  });

  it('updateAgent returns null when the agent is not in the workspace', async () => {
    const tx = makeTx();
    tx.agent.findFirst.mockResolvedValue(null);
    const svc = makeService(tx);
    expect(await svc.updateAgent(WS, UID, 'missing', { active: false })).toBeNull();
    expect(tx.agent.update).not.toHaveBeenCalled();
  });

  it('updateAgent forwards only provided fields and clears recipient_policy on null', async () => {
    const tx = makeTx();
    tx.agent.findFirst.mockResolvedValue(agentRow());
    tx.agent.update.mockResolvedValue(
      agentRow({ autonomyLevel: AgentAutonomyLevel.L0_DRAFT_ONLY }),
    );
    tx.agentInboxItem.count.mockResolvedValue(0);
    const svc = makeService(tx);

    await svc.updateAgent(WS, UID, 'agent-1', {
      autonomyLevel: AgentAutonomyLevel.L0_DRAFT_ONLY,
      recipientPolicy: null,
    });

    expect(tx.agent.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: { autonomyLevel: 'L0_DRAFT_ONLY', recipientPolicy: Prisma.DbNull },
    });
  });

  it('listAgents resolves mailbox addresses + per-agent pending counts in batch', async () => {
    const tx = makeTx();
    tx.agent.findMany.mockResolvedValue([
      agentRow({ id: 'a', key: 'a', mailboxAccountId: 'mb1' }),
      agentRow({ id: 'b', key: 'b', mailboxAccountId: null }),
    ]);
    tx.mailboxAccount.findMany.mockResolvedValue([{ id: 'mb1', emailAddress: 'a@x.dev' }]);
    tx.agentInboxItem.groupBy.mockResolvedValue([{ draftedBy: 'a', _count: { _all: 3 } }]);
    const svc = makeService(tx);

    const views = await svc.listAgents(WS, UID);

    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ key: 'a', mailbox_address: 'a@x.dev', pending_count: 3 });
    expect(views[1]).toMatchObject({ key: 'b', mailbox_address: null, pending_count: 0 });
  });
});
