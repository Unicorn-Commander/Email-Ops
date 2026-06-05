import { ForbiddenException } from '@nestjs/common';
import { CleanupActionKind, CleanupBatchState, User } from '@prisma/client';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { MembershipService } from '../common/workspace/membership.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { ConnectedAccountsService } from './connected-accounts.service';

describe('ConnectedAccountsService', () => {
  const user = {
    id: 'u1',
    email: 'user@example.test',
    username: 'user',
    keycloakId: 'kc-sub-user',
    kcRefreshTokenEnc: 'enc',
    __entitlements: ['email-ops'],
  } as unknown as User;

  const broker = {
    getProviderAccessToken: jest.fn().mockResolvedValue('broker-token'),
  } as unknown as KeycloakBrokerService;

  const membership = {
    resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1'),
  } as unknown as MembershipService;

  const tx = {
    cleanupBatch: {
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'batch-1', ...data })),
      update: jest.fn().mockImplementation(async ({ data }) => ({ id: 'batch-1', ...data })),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    agentInboxItem: {
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'item-1', ...data })),
      update: jest.fn().mockResolvedValue({ id: 'item-1' }),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(user),
    },
  } as any;

  const prisma = {
    withWorkspace: jest.fn(async (_ws: string, _uc: string | null, fn: any) => fn(tx)),
    cleanupBatch: tx.cleanupBatch,
  } as unknown as PrismaService;

  const engine = {
    isConfigured: jest.fn().mockReturnValue(true),
    getInboxStats: jest.fn(),
    analyzeInbox: jest.fn(),
    listMessages: jest.fn(),
    getMessage: jest.fn(),
    batchTrash: jest.fn(),
    batchDelete: jest.fn(),
    backupCreate: jest.fn(),
    backupVerify: jest.fn(),
  } as unknown as ConnectedAccountsEnginePort;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function service() {
    return new ConnectedAccountsService(broker, membership, engine, prisma);
  }

  it('lists linked providers without leaking credentials', async () => {
    const res = await service().listConnectedAccounts(user);
    expect(res.accounts).toEqual([
      { provider: 'gmail', linked: true },
      { provider: 'microsoft', linked: true },
    ]);
  });

  it('plans cleanup without mutating provider state', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [
        {
          id: 'm-1',
          sender: 'Promo <promo@example.com>',
          subject: 'Offer',
          size_bytes: 100,
          labels: ['CATEGORY_PROMOTIONS'],
          is_starred: false,
        },
        {
          id: 'm-2',
          sender: 'Gov <person@agency.gov>',
          subject: 'Notice',
          size_bytes: 200,
          labels: [],
          is_starred: false,
        },
      ],
      next_token: null,
    });

    const plan = await service().planCleanup(user, 'gmail', { query: 'category:promotions' });
    expect(plan.counts.reviewed).toBe(2);
    expect(plan.counts.safe).toBe(1);
    expect(plan.counts.protected).toBe(1);
    expect(plan.protected[0]?.reason).toContain('protected suffix');
    expect(plan.freesBytes).toBe(100);
    expect(engine.batchTrash).not.toHaveBeenCalled();
    expect(engine.batchDelete).not.toHaveBeenCalled();
  });

  it('trashes only the server-approved safe selection', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [
        { id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false },
        { id: 'm-2', sender: 'Gov <person@agency.gov>', size_bytes: 200, is_starred: false },
      ],
      next_token: null,
    });
    (engine.batchTrash as jest.Mock).mockResolvedValue({ count: 1 });

    const plan = await service().planCleanup(user, 'gmail', { query: '' });
    const result = await service().executeCleanup(user, 'gmail', plan, 'trash');

    expect(engine.batchTrash).toHaveBeenCalledWith('gmail', { token: 'broker-token' }, ['m-1']);
    expect(result.status).toBe('completed');
  });

  it('disables permanent delete entirely until archive-and-purge ships', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });

    const plan = await service().planCleanup(user, 'gmail', { query: '' });
    await expect(service().executeCleanup(user, 'gmail', plan, 'delete')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // gated OFF — not even a backup is attempted, and nothing is destroyed
    expect(engine.backupCreate).not.toHaveBeenCalled();
    expect(engine.batchDelete).not.toHaveBeenCalled();
  });

  it('stages agent destructive calls into the approval queue instead of executing them', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });

    const staged = await service().stageCleanupRequest(user, 'gmail', 'trash', CleanupActionKind.TRASH, {
      query: '',
    });
    expect(staged.status).toBe('pending');
    expect(tx.agentInboxItem.create).toHaveBeenCalled();
    expect(engine.batchTrash).not.toHaveBeenCalled();
  });

  it('undo is honest: never flips state to UNDONE without a real restore', async () => {
    (prisma.cleanupBatch.findFirst as jest.Mock).mockResolvedValue({
      id: 'batch-1',
      provider: 'gmail',
      mode: 'trash',
      action: 'TRASH',
      plan: { safe: [] },
      result: { completed: 1 },
      backupRef: null,
      backupVerified: false,
      state: CleanupBatchState.COMPLETED,
    });

    const res = await service().undoBatch(user, 'gmail', 'batch-1');
    // does NOT claim a restore happened
    expect(prisma.cleanupBatch.update).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.status).toBe('rejected');
    expect(res.reason).toMatch(/Gmail Trash/i);
  });

  it('organize and unsubscribe report unsupported without touching the mailbox', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });

    const organized = await service().organize(user, 'gmail', { query: '' });
    expect(organized.ok).toBe(false);
    expect(organized.status).toBe('rejected');

    const unsub = await service().unsubscribe(user, 'gmail', ['promo@example.com']);
    expect(unsub.ok).toBe(false);
    expect(unsub.status).toBe('rejected');

    // the original bug: these must never trash and never fake a completed batch
    expect(engine.batchTrash).not.toHaveBeenCalled();
    expect(engine.batchDelete).not.toHaveBeenCalled();
    expect(tx.cleanupBatch.create).not.toHaveBeenCalled();
  });

  it('does not stage delete/organize for approval (gated until archive)', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });

    const del = await service().stageCleanupRequest(user, 'gmail', 'delete', CleanupActionKind.DELETE, {
      query: '',
    });
    expect(del.status).toBe('rejected');
    expect(tx.agentInboxItem.create).not.toHaveBeenCalled();
  });
});
