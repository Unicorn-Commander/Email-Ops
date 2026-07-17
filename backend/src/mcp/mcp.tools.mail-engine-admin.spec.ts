import { ForbiddenException } from '@nestjs/common';
import { User, WorkspaceRole } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { MailDomainService } from '../mail-engine-admin/mail-domain.service';
import { DEFAULT_MAILBOX_QUOTA_BYTES } from '../mail-engine-admin/mail-engine-admin.constants';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { EmailOpsTools } from './mcp.tools';

describe('EmailOpsTools mail-engine admin tenancy', () => {
  const user = {
    id: 'user-1',
    __ucUid: 'uc-user-1',
    __workspaceClaim: 'ws-1',
  } as unknown as User;

  const membership = {
    resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1'),
    resolveWithRole: jest.fn().mockResolvedValue({ workspaceId: 'ws-1', role: WorkspaceRole.OWNER }),
  } as unknown as MembershipService;

  const admin = {
    isConfigured: jest.fn().mockReturnValue(true),
    listDomains: jest.fn().mockResolvedValue([
      { domain: 'owned.test' },
      { domain: 'foreign.test' },
    ]),
    listAccounts: jest.fn().mockResolvedValue([
      { address: 'alice@owned.test' },
      { address: 'mallory@foreign.test' },
    ]),
    ensureDomain: jest.fn().mockResolvedValue({ provisioned: true, reason: null }),
    removeDomain: jest.fn().mockResolvedValue({ provisioned: true, reason: null }),
    setQuota: jest.fn().mockResolvedValue({ provisioned: true, reason: null }),
    removeAccount: jest.fn().mockResolvedValue({ provisioned: true, reason: null }),
  } as unknown as MailEngineAdminPort;

  const binding = {
    id: 'domain-1',
    workspaceId: 'ws-1',
    domain: 'owned.test',
    verified: false,
    createdAt: new Date('2026-07-17T12:00:00.000Z'),
    updatedAt: new Date('2026-07-17T12:00:00.000Z'),
  };

  const mailDomains = {
    bindDomain: jest.fn().mockResolvedValue(binding),
    listDomains: jest.fn().mockResolvedValue([binding]),
    assertWorkspaceOwnsDomain: jest.fn().mockResolvedValue(binding),
    domainOf: jest.fn((address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase()),
    canonicalDomain: jest.fn((domain: string) => domain.trim().replace(/\.$/, '').toLowerCase()),
  } as unknown as MailDomainService;

  function makeTools(): EmailOpsTools {
    return new EmailOpsTools(
      membership,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      admin,
      mailDomains,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (membership.resolveAndAuthorize as jest.Mock).mockResolvedValue('ws-1');
    (membership.resolveWithRole as jest.Mock).mockResolvedValue({
      workspaceId: 'ws-1',
      role: WorkspaceRole.OWNER,
    });
    (admin.isConfigured as jest.Mock).mockReturnValue(true);
    (admin.listDomains as jest.Mock).mockResolvedValue([
      { domain: 'owned.test' },
      { domain: 'foreign.test' },
    ]);
    (admin.listAccounts as jest.Mock).mockResolvedValue([
      { address: 'alice@owned.test' },
      { address: 'mallory@foreign.test' },
    ]);
    (mailDomains.bindDomain as jest.Mock).mockResolvedValue(binding);
    (mailDomains.listDomains as jest.Mock).mockResolvedValue([binding]);
    (mailDomains.assertWorkspaceOwnsDomain as jest.Mock).mockResolvedValue(binding);
  });

  it('binds ensure_mail_domain before provisioning the canonical domain', async () => {
    await expect(
      makeTools().ensureMailDomain(user, { domain: 'OWNED.test.' }),
    ).resolves.toMatchObject({ status: 'ok' });

    expect(mailDomains.bindDomain).toHaveBeenCalledWith('ws-1', 'uc-user-1', 'OWNED.test.');
    expect(admin.ensureDomain).toHaveBeenCalledWith('owned.test');
    expect((mailDomains.bindDomain as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (admin.ensureDomain as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('returns only bound domains and accounts from global engine list responses', async () => {
    await expect(makeTools().listMailDomains(user, {})).resolves.toEqual({
      domains: [{ domain: 'owned.test' }],
    });
    await expect(makeTools().listMailAccounts(user, {})).resolves.toEqual({
      accounts: [{ address: 'alice@owned.test' }],
    });
    expect(mailDomains.listDomains).toHaveBeenCalledWith('ws-1', 'uc-user-1');
  });

  it.each([
    ['remove_mail_domain', (tools: EmailOpsTools) => tools.removeMailDomain(user, { domain: 'foreign.test' })],
    [
      'set_mailbox_quota',
      (tools: EmailOpsTools) => tools.setMailboxQuota(user, { address: 'user@foreign.test' }),
    ],
    [
      'remove_mailbox_engine',
      (tools: EmailOpsTools) => tools.removeMailboxEngine(user, { address: 'user@foreign.test' }),
    ],
  ])('refuses %s for an unbound domain before calling James', async (_name, invoke) => {
    (mailDomains.assertWorkspaceOwnsDomain as jest.Mock).mockRejectedValueOnce(
      new ForbiddenException('domain is not bound'),
    );

    await expect(invoke(makeTools())).rejects.toThrow(ForbiddenException);
    expect(admin.removeDomain).not.toHaveBeenCalled();
    expect(admin.setQuota).not.toHaveBeenCalled();
    expect(admin.removeAccount).not.toHaveBeenCalled();
  });

  it('applies the 5 GiB default quota only when quota_bytes is omitted', async () => {
    await makeTools().setMailboxQuota(user, { address: 'user@owned.test' });
    expect(mailDomains.assertWorkspaceOwnsDomain).toHaveBeenCalledWith(
      'ws-1',
      'uc-user-1',
      'owned.test',
    );
    expect(admin.setQuota).toHaveBeenCalledWith(
      'user@owned.test',
      DEFAULT_MAILBOX_QUOTA_BYTES,
    );

    await makeTools().setMailboxQuota(user, {
      address: 'user@owned.test',
      quota_bytes: null,
    });
    expect(admin.setQuota).toHaveBeenLastCalledWith('user@owned.test', null);
  });

  it('keeps domain bindings even when James is dormant', async () => {
    (admin.isConfigured as jest.Mock).mockReturnValue(false);

    await expect(makeTools().ensureMailDomain(user, { domain: 'owned.test' })).resolves.toEqual({
      status: 'engine_not_configured',
    });
    expect(mailDomains.bindDomain).toHaveBeenCalled();
    expect(admin.ensureDomain).not.toHaveBeenCalled();
  });
});
