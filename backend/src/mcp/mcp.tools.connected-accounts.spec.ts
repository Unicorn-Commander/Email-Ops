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
});
