import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ConnectedAccountsController } from './connected-accounts.controller';
import { ConnectedAccountsService } from './connected-accounts.service';

describe('ConnectedAccountsController', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';

  function userWith(entitlements: string[]): User {
    const user: WithWorkspaceClaim = {
      id: 'local-user-1',
      email: 'aaron@example.test',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      avatarUrl: null,
      keycloakId: 'kc-sub-aaron',
      passwordHash: null,
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __ucUid: 'kc-sub-aaron',
      __entitlements: entitlements,
      __workspaceClaim: WS,
    };
    return user as User;
  }

  const membership = {
    resolveAndAuthorize: jest.fn().mockResolvedValue(WS),
  } as unknown as jest.Mocked<MembershipService>;

  const connectedAccounts = {
    listConnectedAccounts: jest.fn().mockResolvedValue({
      accounts: [
        { provider: 'gmail', linked: true },
        { provider: 'microsoft', linked: false },
      ],
    }),
    getInboxStats: jest.fn().mockResolvedValue({
      available: true,
      provider: 'gmail',
      stats: { total_messages: 10 },
    }),
    analyzeInbox: jest.fn().mockResolvedValue({
      available: true,
      provider: 'microsoft',
      analysis: { categories: [] },
    }),
    disconnectProvider: jest.fn().mockResolvedValue({
      provider: 'gmail',
      status: 'disconnected',
      broker: 'unlinked',
      mailboxes_deactivated: 1,
      refresh_token_cleared: false,
    }),
  } as unknown as jest.Mocked<ConnectedAccountsService>;

  const savedEnv = process.env.UC_ENTITLEMENT_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env.UC_ENTITLEMENT_MODE;
    else process.env.UC_ENTITLEMENT_MODE = savedEnv;
  });

  function controller() {
    return new ConnectedAccountsController(membership, connectedAccounts);
  }

  it('lists connected accounts after resolving workspace membership', async () => {
    const user = userWith([]);
    await expect(controller().list(user)).resolves.toEqual({
      accounts: [
        { provider: 'gmail', linked: true },
        { provider: 'microsoft', linked: false },
      ],
    });

    expect(membership.resolveAndAuthorize).toHaveBeenCalledWith(user, null);
    expect(connectedAccounts.listConnectedAccounts).toHaveBeenCalledWith(user);
  });

  it('blocks inbox stats without the email-ops cleaner entitlement', async () => {
    const user = userWith([]);
    await expect(controller().stats(user, 'gmail')).rejects.toBeInstanceOf(ForbiddenException);

    expect(membership.resolveAndAuthorize).toHaveBeenCalledWith(user, null);
    expect(connectedAccounts.getInboxStats).not.toHaveBeenCalled();
  });

  it('returns inbox stats with the email-ops cleaner entitlement', async () => {
    const user = userWith(['email-ops']);
    await expect(controller().stats(user, 'gmail')).resolves.toEqual({
      available: true,
      provider: 'gmail',
      stats: { total_messages: 10 },
    });

    expect(connectedAccounts.getInboxStats).toHaveBeenCalledWith(user, 'gmail');
  });

  it('runs inbox analysis with the email-ops cleaner entitlement', async () => {
    const user = userWith(['email-ops']);
    await expect(controller().analyze(user, 'microsoft')).resolves.toEqual({
      available: true,
      provider: 'microsoft',
      analysis: { categories: [] },
    });

    expect(connectedAccounts.analyzeInbox).toHaveBeenCalledWith(user, 'microsoft');
  });

  it("disconnects the requested provider after resolving this user's workspace", async () => {
    const user = userWith([]);
    await expect(controller().disconnect(user, 'gmail')).resolves.toEqual({
      provider: 'gmail',
      status: 'disconnected',
      broker: 'unlinked',
      mailboxes_deactivated: 1,
      refresh_token_cleared: false,
    });

    expect(membership.resolveAndAuthorize).toHaveBeenCalledWith(user, null);
    expect(connectedAccounts.disconnectProvider).toHaveBeenCalledWith(user, 'gmail');
    const body = JSON.stringify(await controller().disconnect(user, 'gmail'));
    expect(body).not.toContain('kc-refresh');
    expect(body).not.toContain('secret');
  });

  it('rejects an unknown provider before disconnect changes anything', async () => {
    const user = userWith(['email-ops']);
    await expect(controller().disconnect(user, 'imap')).rejects.toBeInstanceOf(BadRequestException);

    expect(membership.resolveAndAuthorize).not.toHaveBeenCalled();
    expect(connectedAccounts.disconnectProvider).not.toHaveBeenCalled();
  });

  it('rejects unknown providers before resolving workspace membership', async () => {
    const user = userWith(['email-ops']);
    await expect(controller().stats(user, 'imap')).rejects.toBeInstanceOf(BadRequestException);

    expect(membership.resolveAndAuthorize).not.toHaveBeenCalled();
    expect(connectedAccounts.getInboxStats).not.toHaveBeenCalled();
  });
});
