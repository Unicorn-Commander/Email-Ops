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

  it('refuses permanent delete until backup verification succeeds', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });
    (engine.backupCreate as jest.Mock).mockResolvedValue({
      version: '1.0',
      created_at: '2026-06-05T00:00:00Z',
      query: '',
      total_messages: 1,
      errors: 0,
      path: '/tmp/backup',
      provider: 'gmail',
    });
    (engine.backupVerify as jest.Mock).mockResolvedValue({ success: false });

    const plan = await service().planCleanup(user, 'gmail', { query: '' });
    await expect(service().executeCleanup(user, 'gmail', plan, 'delete')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
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

  it('marks cleanup batches undone', async () => {
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
    expect(prisma.cleanupBatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'batch-1' },
        data: expect.objectContaining({ state: CleanupBatchState.UNDONE }),
      }),
    );
    expect(res.status).toBe('undone');
  });
});
