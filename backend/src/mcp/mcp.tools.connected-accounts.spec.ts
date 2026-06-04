import { ForbiddenException } from '@nestjs/common';
import { User } from '@prisma/client';
import { ConnectedAccountsTools } from './mcp.tools';
import { MembershipService } from '../common/workspace/membership.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';

describe('ConnectedAccountsTools', () => {
  const workspaceId = '0190a000-7e57-7000-8000-0000000edddd';
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    keycloakId: 'uc-sub-1',
  } as User;

  function makeTools(
    svc: Partial<ConnectedAccountsService>,
    membership?: Partial<MembershipService>,
  ) {
    const membershipMock = {
      resolveAndAuthorize: jest.fn().mockResolvedValue(workspaceId),
    } as unknown as MembershipService;
    return new ConnectedAccountsTools(
      (membership ?? membershipMock) as MembershipService,
      svc as ConnectedAccountsService,
    );
  }

  afterEach(() => {
    delete process.env.UC_ENTITLEMENT_MODE;
  });

  it('list_connected_accounts is viewer-level and does not require the cleaner SKU', async () => {
    const connected = {
      listConnectedAccounts: jest.fn().mockResolvedValue({ accounts: [{ id: 'acct-1' }], count: 1 }),
    };
    const tools = makeTools(connected);

    await expect(
      tools.listConnectedAccounts({ ...user, __entitlements: [] } as any, {}),
    ).resolves.toEqual({ accounts: [{ id: 'acct-1' }], count: 1 });
    expect(connected.listConnectedAccounts).toHaveBeenCalledWith(workspaceId, 'uc-sub-1');
  });

  it('get_inbox_stats is blocked without email-ops in enforce mode', async () => {
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
    const tools = makeTools({
      getInboxStats: jest.fn(),
    });

    await expect(
      tools.getInboxStats({ ...user, __entitlements: [] } as any, { account_id: 'acct-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('analyze_inbox is allowed in open mode without the cleaner SKU', async () => {
    process.env.UC_ENTITLEMENT_MODE = 'open';
    const connected = {
      analyzeInbox: jest.fn().mockResolvedValue({ engineAvailable: true, analysis: { ok: true } }),
    };
    const tools = makeTools(connected);

    await expect(
      tools.analyzeInbox({ ...user, __entitlements: [] } as any, { account_id: 'acct-1' }),
    ).resolves.toMatchObject({ engineAvailable: true, analysis: { ok: true } });
    expect(connected.analyzeInbox).toHaveBeenCalledWith(workspaceId, 'uc-sub-1', 'acct-1');
  });
});
