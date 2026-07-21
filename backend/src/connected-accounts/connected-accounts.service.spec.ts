import { BadGatewayException, ForbiddenException } from '@nestjs/common';
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
    cleanupBatch: {
      findFirst: jest.fn(async () => {
        throw new Error('cleanupBatch.findFirst must be called through withWorkspace');
      }),
      findMany: jest.fn(async () => {
        throw new Error('cleanupBatch.findMany must be called through withWorkspace');
      }),
    },
  } as unknown as PrismaService;

  const engine = {
    isConfigured: jest.fn().mockReturnValue(true),
    getInboxStats: jest.fn(),
    analyzeInbox: jest.fn(),
    listMessages: jest.fn(),
    getMessage: jest.fn(),
    batchTrash: jest.fn(),
    batchDelete: jest.fn(),
    batchArchive: jest.fn(),
    archiveCreate: jest.fn(),
    archiveVerify: jest.fn(),
    archiveRestore: jest.fn(),
    backupCreate: jest.fn(),
    backupVerify: jest.fn(),
  } as unknown as ConnectedAccountsEnginePort;

  const archiveStorage = {
    bucket: 'archives',
    presignGet: jest.fn().mockResolvedValue('https://garage.example/archive.zip'),
    deleteObject: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function service() {
    return new ConnectedAccountsService(broker, membership, engine, prisma, archiveStorage);
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

    const plan = await service().planCleanup(user, 'gmail', { query: 'category:promotions' });
    const result = await service().executeCleanup(user, 'gmail', plan, 'trash');

    expect(engine.batchTrash).toHaveBeenCalledWith('gmail', { token: 'broker-token' }, ['m-1']);
    expect(result.status).toBe('completed');
  });

  it('records FAILED (not a silent COMPLETED) when the engine rejects the trash', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [
        { id: 'm-1', sender: 'Promo <promo@shop.com>', size_bytes: 100, labels: ['CATEGORY_PROMOTIONS'], is_starred: false },
      ],
      next_token: null,
    });
    // The engine rejected the call (auth expired / rate-limited / transport) — the
    // client maps a non-2xx to null. That must NOT collapse to "completed, 0 trashed".
    (engine.batchTrash as jest.Mock).mockResolvedValue(null);

    const plan = await service().planCleanup(user, 'gmail', { query: 'category:promotions' });
    await expect(service().executeCleanup(user, 'gmail', plan, 'trash')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(engine.batchTrash).toHaveBeenCalled();
    // No COMPLETED batch row is written for a cleanup that never happened.
    expect(tx.cleanupBatch.create).not.toHaveBeenCalled();
  });

  it('SAFETY: personal mail is never "safe", and an empty selection trashes nothing', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [
        { id: 'm-1', sender: 'Promo <promo@shop.com>', size_bytes: 100, labels: ['CATEGORY_PROMOTIONS'], is_starred: false },
        { id: 'm-2', sender: 'Friend <friend@example.com>', size_bytes: 200, labels: [], is_starred: false },
      ],
      next_token: null,
    });
    (engine.batchTrash as jest.Mock).mockResolvedValue({ count: 0 });

    // Category-scoped plan (no free-text query): only the promotions row is "safe";
    // the personal message is reviewed but NEVER swept into safe-to-delete.
    const plan = await service().planCleanup(user, 'gmail', { categories: ['promotional'] });
    expect(plan.counts.reviewed).toBe(2);
    expect(plan.safe.map((r) => r.id)).toEqual(['m-1']);

    // An empty explicit selection must be a no-op — never fall back to "everything".
    await service().executeCleanup(user, 'gmail', { ...plan, safe: [] } as never, 'trash');
    expect(engine.batchTrash).toHaveBeenCalledWith('gmail', { token: 'broker-token' }, []);
  });

  it('permanent delete requires a verified Garage archive before purge', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });
    (engine.archiveCreate as jest.Mock).mockResolvedValue({
      bucket: 'archives',
      key: 'workspaces/ws-1/archives/gmail/batch.eml.zip',
      format: 'eml_zip',
      total_messages: 1,
      bytes: 1234,
      sha256: 'sha',
      created_at: '2026-06-05T00:00:00.000Z',
    });
    (engine.archiveVerify as jest.Mock).mockResolvedValue({
      success: true,
      total_messages: 1,
      bytes: 1234,
      sha256: 'sha',
      message: 'ok',
    });
    (engine.batchDelete as jest.Mock).mockResolvedValue({ count: 1 });

    const plan = await service().planCleanup(user, 'gmail', { query: 'category:promotions' });
    const result = await service().executeCleanup(user, 'gmail', plan, 'delete');
    expect(engine.archiveCreate).toHaveBeenCalled();
    expect(engine.archiveVerify).toHaveBeenCalledWith('archives', 'workspaces/ws-1/archives/gmail/batch.eml.zip');
    expect(engine.batchDelete).toHaveBeenCalledWith('gmail', { token: 'broker-token' }, ['m-1']);
    expect(result.backup_ref?.verified).toBe(true);
  });

  it('reports partial engine counts correctly (completed vs failed)', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [
        { id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false },
        { id: 'm-2', sender: 'Promo <promo2@example.com>', size_bytes: 100, is_starred: false },
      ],
      next_token: null,
    });
    // Engine only completed 1 of 2 requested
    (engine.batchTrash as jest.Mock).mockResolvedValue({ count: 1 });

    const plan = await service().planCleanup(user, 'gmail', { query: 'category:promotions' });
    const result = await service().executeCleanup(user, 'gmail', plan, 'trash');

    expect(result.result.completed).toBe(1);
    expect(result.result.failed).toBe(1);
    expect(result.result.total_attempted).toBe(2);
  });

  it('does not purge when archive verification fails', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });
    (engine.archiveCreate as jest.Mock).mockResolvedValue({
      bucket: 'archives',
      key: 'bad.zip',
      format: 'eml_zip',
      total_messages: 1,
      bytes: 1234,
      sha256: 'sha',
      created_at: '2026-06-05T00:00:00.000Z',
    });
    (engine.archiveVerify as jest.Mock).mockResolvedValue({ success: false, message: 'bad sha' });

    const plan = await service().planCleanup(user, 'gmail', { query: 'category:promotions' });
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
      query: 'category:promotions',
    });
    expect(staged.status).toBe('pending');
    expect(tx.agentInboxItem.create).toHaveBeenCalled();
    expect(engine.batchTrash).not.toHaveBeenCalled();
  });

  it('undo restores from a live archive and flips state to UNDONE', async () => {
    (tx.cleanupBatch.findFirst as jest.Mock).mockResolvedValue({
      id: 'batch-1',
      provider: 'gmail',
      mode: 'delete',
      action: CleanupActionKind.DELETE,
      plan: { safe: [] },
      result: { completed: 1 },
      backupRef: 'archive.zip',
      backupVerified: true,
      archiveBucket: 'archives',
      archiveKey: 'archive.zip',
      archiveExpiresAt: new Date(Date.now() + 3600_000),
      archiveRetained: false,
      restoredAt: null,
      state: CleanupBatchState.COMPLETED,
    });
    (engine.archiveRestore as jest.Mock).mockResolvedValue({ restored: 1, failed: [] });

    const res = await service().undoBatch(user, 'gmail', 'batch-1');
    expect(engine.archiveRestore).toHaveBeenCalledWith('gmail', { token: 'broker-token' }, 'archives', 'archive.zip');
    expect(tx.cleanupBatch.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'batch-1' },
      data: expect.objectContaining({ state: CleanupBatchState.UNDONE }),
    }));
    expect(res.ok).toBe(true);
    expect(res.status).toBe('undone');
    expect(prisma.withWorkspace).toHaveBeenCalledWith('ws-1', 'kc-sub-user', expect.any(Function));
    expect(prisma.cleanupBatch.findFirst).not.toHaveBeenCalled();
  });

  it('undo does NOT flip to UNDONE when the restore fails — the archive stays live for retry', async () => {
    (tx.cleanupBatch.findFirst as jest.Mock).mockResolvedValue({
      id: 'batch-1',
      provider: 'gmail',
      mode: 'delete',
      action: CleanupActionKind.DELETE,
      plan: { safe: [] },
      result: { completed: 1 },
      backupRef: 'archive.zip',
      backupVerified: true,
      archiveBucket: 'archives',
      archiveKey: 'archive.zip',
      archiveExpiresAt: new Date(Date.now() + 3600_000),
      archiveRetained: false,
      restoredAt: null,
      state: CleanupBatchState.COMPLETED,
    });
    // Engine reachable, but nothing re-imported (every id failed). Marking UNDONE here
    // would set restoredAt and retire the still-live archive, stranding the mail.
    (engine.archiveRestore as jest.Mock).mockResolvedValue({
      restored: 0,
      failed: [{ id: 'm-1', error: 'import rejected' }],
    });

    const res = await service().undoBatch(user, 'gmail', 'batch-1');
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    // The batch is NOT written to UNDONE, so archiveLive() stays true and a retry works.
    expect(tx.cleanupBatch.update).not.toHaveBeenCalled();
  });

  it('organize performs real non-destructive archive; unsubscribe remains unsupported', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });
    (engine.batchArchive as jest.Mock).mockResolvedValue({ count: 1 });

    const organized = await service().organize(user, 'gmail', { query: 'category:promotions' });
    expect(organized.ok).toBe(true);
    expect(organized.status).toBe('completed');
    expect(engine.batchArchive).toHaveBeenCalledWith('gmail', { token: 'broker-token' }, ['m-1'], null);

    const unsub = await service().unsubscribe(user, 'gmail', ['promo@example.com']);
    expect(unsub.ok).toBe(false);
    expect(unsub.status).toBe('rejected');

    // the original bug: these must never trash and never fake a completed batch
    expect(engine.batchTrash).not.toHaveBeenCalled();
    expect(engine.batchDelete).not.toHaveBeenCalled();
    expect(tx.cleanupBatch.create).toHaveBeenCalled();
  });

  it('stages delete and organize for approval without executing provider writes', async () => {
    (engine.listMessages as jest.Mock).mockResolvedValue({
      messages: [{ id: 'm-1', sender: 'Promo <promo@example.com>', size_bytes: 100, is_starred: false }],
      next_token: null,
    });

    const del = await service().stageCleanupRequest(user, 'gmail', 'delete', CleanupActionKind.DELETE, {
      query: '',
    });
    expect(del.status).toBe('pending');
    const org = await service().stageCleanupRequest(user, 'gmail', 'archive', CleanupActionKind.ORGANIZE, {
      query: '',
    });
    expect(org.status).toBe('pending');
    expect(tx.agentInboxItem.create).toHaveBeenCalled();
    expect(engine.batchTrash).not.toHaveBeenCalled();
    expect(engine.batchDelete).not.toHaveBeenCalled();
  });
});
