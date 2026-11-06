import {
  clearEffectiveEntitlementsCacheForTests,
  resolveEffectiveEntitlements,
} from './entitlement-resolver';
import {
  checkCleanerEntitlement,
  checkMailboxHostingEntitlement,
  checkVaultEntitlement,
} from './entitlement';
import { OrgEntitlement } from '../auth/org-entitlements.client';

describe('effective Email-Ops entitlement resolver', () => {
  const envValues: Record<string, string> = {
    EMAIL_OPS_ENTITLEMENTS_ENABLED: 'true',
    UC_ENTITLEMENTS_URL: 'https://ops.example.test/api/v1/entitlements',
    UC_ENTITLEMENT_MODE: 'enforce',
  };
  const getEnv = (key: string) => envValues[key];
  const user = (entitlements: string[] = []) =>
    ({
      id: 'fixture-local-user',
      keycloakId: 'fixture-human-sub',
      __ucUid: 'fixture-human-sub',
      __entitlements: entitlements,
    }) as any;
  const org = (entitlements: string[], entitled = true): OrgEntitlement => ({
    orgId: 'org-lantern-harbor',
    orgName: 'Lantern Harbor Advisory',
    tier: 'byok',
    role: 'owner',
    entitlements,
    allowed: entitled,
    entitled,
  });

  beforeEach(() => {
    clearEffectiveEntitlementsCacheForTests();
  });

  it('maps an entitled org to the cleaner SKU', async () => {
    const resolve = jest.fn().mockResolvedValue(org(['email_ops_access']));
    const effective = await resolveEffectiveEntitlements(user(), 'org-lantern-harbor', {
      accessToken: 'fixture-human-bearer',
      getEnv,
      resolveOrgEntitlement: resolve,
    });

    expect(effective.entitlements).toContain('email-ops');
    expect(
      checkCleanerEntitlement(effective.entitlements, 'org-lantern-harbor', getEnv).allowed,
    ).toBe(true);
  });

  it('denies an org without email_ops_access in enforce mode', async () => {
    const effective = await resolveEffectiveEntitlements(user(), 'org-lantern-harbor', {
      accessToken: 'fixture-human-bearer',
      getEnv,
      resolveOrgEntitlement: jest.fn().mockResolvedValue(org(['calendar_access'], false)),
    });

    expect(
      checkCleanerEntitlement(effective.entitlements, 'org-lantern-harbor', getEnv),
    ).toMatchObject({
      allowed: false,
      mode: 'enforce',
    });
  });

  it('falls back to claims only when Ops-Center is down', async () => {
    const resolve = jest.fn().mockRejectedValue(new Error('fixture endpoint down'));
    const effective = await resolveEffectiveEntitlements(user(), 'org-lantern-harbor', {
      accessToken: 'fixture-human-bearer',
      getEnv,
      resolveOrgEntitlement: resolve,
    });

    expect(effective.entitlements).toEqual([]);
    expect(effective.orgId).toBeNull();
    expect(
      checkCleanerEntitlement(effective.entitlements, 'org-lantern-harbor', getEnv).allowed,
    ).toBe(false);
  });

  it.each([
    [0, 0, false],
    [2, 1, true],
    [2, 2, false],
  ])(
    'enforces the purchased hosted-mailbox count (%i purchased, %i hosted)',
    async (limit, current, allowed) => {
      const effective = await resolveEffectiveEntitlements(user(), 'org-lantern-harbor', {
        accessToken: 'fixture-human-bearer',
        currentHostedMailboxes: current,
        getEnv,
        resolveOrgEntitlement: jest
          .fn()
          .mockResolvedValue(org(['email_ops_access', `email_ops_mailboxes:${limit}`])),
      });
      const decision = checkCleanerEntitlement(
        effective.entitlements,
        'org-lantern-harbor',
        getEnv,
      );
      expect(decision.allowed).toBe(true);

      const mailbox = checkMailboxHostingEntitlement(
        effective.entitlements,
        'org-lantern-harbor',
        getEnv,
        { currentHostedMailboxes: current, mailboxLimit: effective.mailboxLimit },
      );
      expect(mailbox.allowed).toBe(allowed);
      if (!allowed && current >= limit) {
        expect(mailbox.reason).toContain(
          `your plan includes ${limit} hosted mailboxes; add more in Billing`,
        );
      }
    },
  );

  it('does not imply vault from the bundled base SKU', async () => {
    const effective = await resolveEffectiveEntitlements(user(), 'org-lantern-harbor', {
      accessToken: 'fixture-human-bearer',
      getEnv,
      resolveOrgEntitlement: jest.fn().mockResolvedValue(org(['email_ops_access'])),
    });

    expect(
      checkVaultEntitlement(effective.entitlements, 'org-lantern-harbor', getEnv).allowed,
    ).toBe(false);
  });

  it('leaves claims unchanged and does not call Ops-Center when the flag is off', async () => {
    const resolve = jest.fn();
    const effective = await resolveEffectiveEntitlements(
      user(['email-ops']),
      'org-lantern-harbor',
      {
        accessToken: 'fixture-human-bearer',
        getEnv: (key) => (key === 'EMAIL_OPS_ENTITLEMENTS_ENABLED' ? 'false' : envValues[key]),
        resolveOrgEntitlement: resolve,
      },
    );

    expect(effective).toEqual({
      entitlements: ['email-ops'],
      mailboxLimit: null,
      orgId: null,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps PAT callers claim-only even when a bearer seam is present', async () => {
    const resolve = jest.fn().mockResolvedValue(org(['email_ops_access']));
    const effective = await resolveEffectiveEntitlements(
      { ...user(), __patAuth: { scopes: ['mail:read'] }, __entitlementBearer: 'fixture-pat' },
      'org-lantern-harbor',
      { getEnv, resolveOrgEntitlement: resolve },
    );

    expect(effective.entitlements).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});
