import {
  clearOrgEntitlementCacheForTests,
  emailOpsEntitlementFeatureKey,
  emailOpsEntitlementsEnabled,
  EMAIL_OPS_ENTITLEMENTS_TIMEOUT_MS,
  resolveOrgEntitlement,
} from './org-entitlements.client';

describe('Email-Ops organization entitlements client', () => {
  const orgId = '6e40af62-214d-4155-86f1-37dea8bcc53b';
  const token = 'fixture-human-bearer';
  const env = (overrides: Record<string, string | undefined> = {}) =>
    ((key: string) =>
      ({
        EMAIL_OPS_ENTITLEMENTS_ENABLED: 'true',
        UC_ENTITLEMENTS_URL: 'https://ops.example.test/api/v1/entitlements',
        EMAIL_OPS_ENTITLEMENT_FEATURE_KEY: 'email_ops_access',
        ...overrides,
      })[key]) as (key: string) => string | undefined;

  afterEach(() => {
    clearOrgEntitlementCacheForTests();
    jest.useRealTimers();
  });

  it('arms only when enabled and configured, and exposes the configured feature key', () => {
    expect(emailOpsEntitlementsEnabled(env())).toBe(true);
    expect(emailOpsEntitlementsEnabled(env({ EMAIL_OPS_ENTITLEMENTS_ENABLED: 'false' }))).toBe(
      false,
    );
    expect(emailOpsEntitlementsEnabled(env({ UC_ENTITLEMENTS_URL: '' }))).toBe(false);
    expect(emailOpsEntitlementFeatureKey(env())).toBe('email_ops_access');
    expect(
      emailOpsEntitlementFeatureKey(env({ EMAIL_OPS_ENTITLEMENT_FEATURE_KEY: 'custom_access' })),
    ).toBe('custom_access');
  });

  it('parses the measured response shape and accepts the Email-Ops SKU alias', async () => {
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            org_id: orgId,
            tier: 'byok',
            role: 'owner',
            entitlements: ['email-ops', 'ai-metered'],
            org_name: 'Lantern Harbor Advisory',
          }),
        }) as Response,
    );

    await expect(
      resolveOrgEntitlement(token, {
        subject: 'fixture-owner-sub',
        getEnv: env(),
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      orgId,
      tier: 'byok',
      role: 'owner',
      orgName: 'Lantern Harbor Advisory',
      entitlements: ['email-ops', 'ai-metered'],
      allowed: true,
      entitled: true,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ops.example.test/api/v1/entitlements',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }),
    );
  });

  it.each([404, 500])('returns null for non-2xx status %s', async (status) => {
    const fetchImpl = jest.fn(
      async () => ({ ok: false, status, json: jest.fn() }) as unknown as Response,
    );
    await expect(resolveOrgEntitlement(token, { getEnv: env(), fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null on a timeout without throwing into login', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('fixture timeout')));
        }),
    );
    const pending = resolveOrgEntitlement(token, { getEnv: env(), fetchImpl });
    await jest.advanceTimersByTimeAsync(EMAIL_OPS_ENTITLEMENTS_TIMEOUT_MS);
    await expect(pending).resolves.toBeNull();
  });

  it('returns null for garbage or malformed bodies and never logs the bearer', async () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const fetchImpl = jest.fn(
      async () => ({ ok: true, status: 200, json: async () => 'garbage' }) as Response,
    );
    await expect(
      resolveOrgEntitlement(token, { getEnv: env(), fetchImpl, logger }),
    ).resolves.toBeNull();
    const messages = [...logger.log.mock.calls, ...logger.warn.mock.calls].flat();
    expect(messages.join(' ')).not.toContain(token);

    const malformedFetch = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ org_id: orgId, entitlements: [{ code: 'email_ops_access' }] }),
        }) as Response,
    );
    await expect(
      resolveOrgEntitlement(token, { getEnv: env(), fetchImpl: malformedFetch }),
    ).resolves.toBeNull();
  });

  it('caches bearer verdicts by subject and token hash for min(60 seconds, exp)', async () => {
    let now = 1_000_000;
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ org_id: orgId, role: 'member', entitlements: [] }),
        }) as Response,
    );
    const options = {
      subject: 'fixture-member-sub',
      exp: 1_005,
      cache: true,
      getEnv: env(),
      fetchImpl,
      now: () => now,
    };

    await resolveOrgEntitlement(token, options);
    now += 4_000;
    await resolveOrgEntitlement(token, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 2_000;
    await resolveOrgEntitlement(token, options);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await resolveOrgEntitlement(token, { ...options, subject: 'other-sub' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
