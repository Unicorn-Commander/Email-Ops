import { AgentInboxState, AgentAutonomyLevel, AgentTier, MailboxOwnerKind, MailboxProvisionState, User } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentViewService } from './agent-view.service';

describe('AgentViewService', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';
  const UID = 'kc-sub-aaron';

  function user(): User {
    return {
      id: 'user-1',
      email: 'aaron@example.com',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'Stransky',
      picture: null,
      keycloakId: UID,
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } as User;
  }

  function agent(over: Record<string, unknown> = {}) {
    return {
      id: 'agent-1',
      workspaceId: WS,
      key: 'customer-ops',
      displayName: 'Customer-Ops',
      description: null,
      mailboxAccountId: 'mb-1',
      autonomyLevel: AgentAutonomyLevel.L1_APPROVE_TO_SEND,
      recipientPolicy: null,
      active: true,
      tier: AgentTier.UNSPECIFIED,
      managerAgentKey: null,
      brigadeAgentId: null,
      paused: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      ...over,
    };
  }

  function mailbox(over: Record<string, unknown> = {}) {
    return {
      id: 'mb-1',
      workspaceId: WS,
      emailAddress: 'customer-ops@example.com',
      displayName: null,
      imapHost: null,
      imapPort: null,
      jmapUrl: null,
      smtpHost: null,
      smtpPort: null,
      secretRef: null,
      isDefault: false,
      postmarkLane: true,
      active: true,
      provider: 'stalwart',
      ownerKind: MailboxOwnerKind.AGENT,
      ownerKey: 'customer-ops',
      kind: 'agent',
      provisionState: MailboxProvisionState.REGISTERED,
      inboundCursor: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...over,
    };
  }

  function makeTx() {
    return {
      agent: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      mailboxAccount: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      agentMailbox: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      agentInboxItem: {
        groupBy: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      emailMessage: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
  }

  function make(tx: ReturnType<typeof makeTx>, emailOverrides: Partial<EmailService> = {}) {
    const prisma = {
      withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
    } as unknown as PrismaService;
    const email = {
      listMailboxInbox: jest.fn().mockResolvedValue([]),
      listAgentInbox: jest.fn().mockResolvedValue([]),
      getWorkspaceMailCounts: jest.fn().mockResolvedValue([]),
      ...emailOverrides,
    } as unknown as EmailService;
    return { service: new AgentViewService(prisma, email), prisma, email };
  }

  it('returns the composed view for an agent with a mailbox', async () => {
    const tx = makeTx();
    tx.agent.findFirst.mockResolvedValue(agent());
    tx.mailboxAccount.findFirst.mockResolvedValue(mailbox());
    tx.agentInboxItem.groupBy.mockResolvedValue([
      { state: AgentInboxState.PENDING, _count: { _all: 2 } },
      { state: AgentInboxState.APPROVED, _count: { _all: 1 } },
    ]);
    tx.agentInboxItem.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-07-01T10:00:00.000Z'),
      createdAt: new Date('2026-07-01T09:00:00.000Z'),
    });
    tx.emailMessage.findFirst.mockResolvedValue({
      sentAt: new Date('2026-07-02T10:00:00.000Z'),
      createdAt: new Date('2026-07-02T09:00:00.000Z'),
    });
    const threads = [{ id: 't1', subject: 'Hi', message_count: 1, unread: true, last_message_at: null, last_snippet: null, participants: [] }];
    const pending = [
      { id: 'i1', drafted_by: 'customer-ops', state: 'pending' },
      { id: 'i2', drafted_by: 'other-agent', state: 'pending' },
    ];
    const { service, email } = make(tx, {
      listMailboxInbox: jest.fn().mockResolvedValue(threads),
      listAgentInbox: jest.fn().mockResolvedValue(pending),
      getWorkspaceMailCounts: jest.fn().mockResolvedValue([
        { mailbox_id: 'mb-1', address: 'customer-ops@example.com', inbox_unread: 4, inbox_total: 9 },
      ]),
    } as Partial<EmailService>);

    const view = await service.getAgentMailbox(user(), { workspaceId: WS, agentId: 'agent-1', threadLimit: 10 });

    expect(tx.agent.findFirst).toHaveBeenCalledWith({ where: { id: 'agent-1', workspaceId: WS } });
    expect(email.listMailboxInbox).toHaveBeenCalledWith(WS, UID, 'mb-1', 10, 'inbox');
    expect(view).toMatchObject({
      agent: {
        id: 'agent-1',
        name: 'Customer-Ops',
        handle: 'customer-ops',
        mailbox: { id: 'mb-1', address: 'customer-ops@example.com', provider: 'stalwart' },
      },
      threads,
      agentInbox: {
        pending: [{ id: 'i1', drafted_by: 'customer-ops', state: 'pending' }],
        counts: { pending: 2, approved: 1, rejected: 0 },
      },
      stats: { unread: 4, total: 9, lastActivityAt: '2026-07-02T10:00:00.000Z' },
    });
  });

  it('returns an agent with no mailbox and still includes its agent-inbox', async () => {
    const tx = makeTx();
    tx.agent.findFirst.mockResolvedValue(agent({ mailboxAccountId: null }));
    tx.agentInboxItem.groupBy.mockResolvedValue([
      { state: AgentInboxState.PENDING, _count: { _all: 1 } },
    ]);
    const pending = [{ id: 'i1', drafted_by: 'customer-ops', state: 'pending' }];
    const { service, email } = make(tx, {
      listAgentInbox: jest.fn().mockResolvedValue(pending),
    } as Partial<EmailService>);

    const view = await service.getAgentMailbox(user(), { workspaceId: WS, agentId: 'agent-1' });

    expect(tx.mailboxAccount.findFirst).not.toHaveBeenCalled();
    expect(email.listMailboxInbox).not.toHaveBeenCalled();
    expect(view).toMatchObject({
      agent: { mailbox: null },
      threads: [],
      agentInbox: {
        pending,
        counts: { pending: 1, approved: 0, rejected: 0 },
      },
      stats: { lastActivityAt: null },
    });
  });

  it('falls back to a READ-only binding when the agent has no send identity', async () => {
    const tx = makeTx();
    tx.agent.findFirst.mockResolvedValue(agent({ mailboxAccountId: null }));
    // No send identity, but a readable binding exists → show its inbox.
    tx.agentMailbox.findFirst.mockResolvedValue({
      mailbox: mailbox({ id: 'mb-read', emailAddress: 'shared@example.com' }),
    });
    tx.agentInboxItem.groupBy.mockResolvedValue([]);
    const threads = [{ id: 't1', subject: 'Hi', message_count: 1, unread: false, last_message_at: null, last_snippet: null, participants: [] }];
    const { service, email } = make(tx, {
      listMailboxInbox: jest.fn().mockResolvedValue(threads),
    } as Partial<EmailService>);

    const view = await service.getAgentMailbox(user(), { workspaceId: WS, agentId: 'agent-1' });

    // Reads the readable binding's mailbox, not the (null) send identity.
    expect(tx.agentMailbox.findFirst).toHaveBeenCalled();
    expect(email.listMailboxInbox).toHaveBeenCalledWith(WS, UID, 'mb-read', 25, 'inbox');
    expect(view?.agent.mailbox).toMatchObject({ id: 'mb-read', address: 'shared@example.com' });
    expect(view?.threads).toEqual(threads);
  });

  it('refuses a cross-workspace agent id by returning null from the fenced lookup', async () => {
    const tx = makeTx();
    tx.agent.findFirst.mockResolvedValue(null);
    const { service, email } = make(tx);

    await expect(service.getAgentMailbox(user(), { workspaceId: WS, agentId: 'foreign-agent' })).resolves.toBeNull();

    expect(tx.agent.findFirst).toHaveBeenCalledWith({ where: { id: 'foreign-agent', workspaceId: WS } });
    expect(email.listMailboxInbox).not.toHaveBeenCalled();
    expect(email.listAgentInbox).not.toHaveBeenCalled();
  });

  it('returns roster counts for every agent without fetching threads', async () => {
    const tx = makeTx();
    tx.agent.findMany.mockResolvedValue([
      agent({ id: 'agent-1', key: 'customer-ops', displayName: 'Customer-Ops', mailboxAccountId: 'mb-1' }),
      agent({ id: 'agent-2', key: 'sales-ops', displayName: 'Sales-Ops', mailboxAccountId: 'mb-2' }),
      agent({ id: 'agent-3', key: 'research', displayName: 'Research', mailboxAccountId: null }),
    ]);
    tx.mailboxAccount.findMany.mockResolvedValue([
      mailbox({ id: 'mb-1', emailAddress: 'customer-ops@example.com', ownerKey: 'customer-ops' }),
      mailbox({ id: 'mb-2', emailAddress: 'sales-ops@example.com', ownerKey: 'sales-ops' }),
    ]);
    tx.agentInboxItem.groupBy.mockResolvedValue([
      { draftedBy: 'customer-ops', _count: { _all: 3 } },
      { draftedBy: 'research', _count: { _all: 1 } },
    ]);
    const { service, email } = make(tx, {
      getWorkspaceMailCounts: jest.fn().mockResolvedValue([
        { mailbox_id: 'mb-1', address: 'customer-ops@example.com', inbox_unread: 7, inbox_total: 20 },
        { mailbox_id: 'mb-2', address: 'sales-ops@example.com', inbox_unread: 2, inbox_total: 8 },
      ]),
    } as Partial<EmailService>);

    const roster = await service.listAgentMailboxes(user(), WS);

    expect(email.listMailboxInbox).not.toHaveBeenCalled();
    expect(tx.agentInboxItem.groupBy).toHaveBeenCalledWith({
      by: ['draftedBy'],
      where: {
        workspaceId: WS,
        state: AgentInboxState.PENDING,
        draftedBy: { in: ['customer-ops', 'sales-ops', 'research'] },
      },
      _count: { _all: true },
    });
    expect(roster).toMatchObject({
      count: 3,
      items: [
        {
          agent: { id: 'agent-1', handle: 'customer-ops' },
          mailbox: { address: 'customer-ops@example.com', unread: 7, pending: 3 },
        },
        {
          agent: { id: 'agent-2', handle: 'sales-ops' },
          mailbox: { address: 'sales-ops@example.com', unread: 2, pending: 0 },
        },
        {
          agent: { id: 'agent-3', handle: 'research', mailbox: null },
          mailbox: { address: null, unread: 0, pending: 1 },
        },
      ],
    });
  });
});
