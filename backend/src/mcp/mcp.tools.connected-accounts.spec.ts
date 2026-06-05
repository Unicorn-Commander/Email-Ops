import { ForbiddenException } from '@nestjs/common';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { ConnectedAccountsTools } from './mcp.tools';

describe('ConnectedAccountsTools', () => {
  const user = {
    id: 'u1',
    email: 'user@example.test',
    __entitlements: [],
  } as unknown as User;

  const membership = {
    resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1'),
  } as unknown as MembershipService;

  const connectedAccounts = {
    listConnectedAccounts: jest.fn().mockResolvedValue({
      accounts: [
        { provider: 'gmail', linked: true },
        { provider: 'microsoft', linked: false },
      ],
    }),
    getInboxStats: jest.fn().mockResolvedValue({ available: true, provider: 'gmail', stats: {} }),
    analyzeInbox: jest
      .fn()
      .mockResolvedValue({ available: true, provider: 'microsoft', analysis: {} }),
    planCleanup: jest.fn().mockResolvedValue({
      provider: 'gmail',
      criteria: {},
      counts: { reviewed: 1, safe: 1, protected: 0 },
      freesBytes: 10,
      protected: [],
      safe: [],
      backup_query: '',
    }),
    stageCleanupRequest: jest.fn().mockResolvedValue({
      ok: true,
      provider: 'gmail',
      mode: 'trash',
      batch_id: 'batch-1',
      action: 'trash',
      plan: {
        provider: 'gmail',
        criteria: {},
        counts: { reviewed: 1, safe: 1, protected: 0 },
        freesBytes: 10,
        protected: [],
        safe: [],
        backup_query: '',
      },
      result: { completed: 0, failed: 0, bytes_freed: 0, total_attempted: 1 },
      status: 'pending',
      staged: true,
      staged_item_id: 'item-1',
    }),
    undoBatch: jest.fn().mockResolvedValue({
      ok: true,
      provider: 'gmail',
      mode: 'undo',
      batch_id: 'batch-1',
      action: 'undo',
      plan: {
        provider: 'gmail',
        criteria: {},
        counts: { reviewed: 1, safe: 1, protected: 0 },
        freesBytes: 10,
        protected: [],
        safe: [],
        backup_query: '',
      },
      result: { completed: 0, failed: 0, bytes_freed: 0, total_attempted: 0 },
      status: 'undone',
    }),
  } as unknown as ConnectedAccountsService;

  const prevMode = process.env.UC_ENTITLEMENT_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
  });

  afterEach(() => {
    if (prevMode === undefined) delete process.env.UC_ENTITLEMENT_MODE;
    else process.env.UC_ENTITLEMENT_MODE = prevMode;
  });

  function tools() {
    return new ConnectedAccountsTools(membership, connectedAccounts);
  }

  it('lets viewers list connected accounts without an SKU gate', async () => {
    await expect(tools().listConnectedAccounts(user, {})).resolves.toEqual({
      accounts: [
        { provider: 'gmail', linked: true },
        { provider: 'microsoft', linked: false },
      ],
    });
    expect(connectedAccounts.listConnectedAccounts).toHaveBeenCalledWith(user);
  });

  it('blocks inbox stats without email-ops in enforce mode', async () => {
    await expect(
      tools().getInboxStats(user, { provider: 'gmail' }),
    ).rejects.toThrow(ForbiddenException);
    expect(connectedAccounts.getInboxStats).not.toHaveBeenCalled();
  });

  it('allows inbox stats in open mode without the SKU', async () => {
    process.env.UC_ENTITLEMENT_MODE = 'open';
    await expect(
      tools().getInboxStats(user, { provider: 'gmail' }),
    ).resolves.toEqual({ available: true, provider: 'gmail', stats: {} });
    expect(connectedAccounts.getInboxStats).toHaveBeenCalledWith(user, 'gmail');
  });

  it('allows inbox analysis in open mode without the SKU', async () => {
    process.env.UC_ENTITLEMENT_MODE = 'open';
    await expect(
      tools().analyzeInbox(user, { provider: 'microsoft' }),
    ).resolves.toEqual({ available: true, provider: 'microsoft', analysis: {} });
    expect(connectedAccounts.analyzeInbox).toHaveBeenCalledWith(user, 'microsoft');
  });

  it('stages agent trash calls into the approval queue', async () => {
    const entitled = { ...user, __entitlements: ['email-ops'] } as User;
    await expect(
      tools().cleanTrash(entitled, { provider: 'gmail', criteria: {} }),
    ).resolves.toEqual(expect.objectContaining({ status: 'pending', staged: true }));
    expect(connectedAccounts.stageCleanupRequest).toHaveBeenCalledWith(
      entitled,
      'gmail',
      'trash',
      'TRASH',
      {},
    );
  });
});
