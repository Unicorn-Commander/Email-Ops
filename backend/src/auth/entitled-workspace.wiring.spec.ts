import { User, WorkspaceRole } from '@prisma/client';
import { NoWorkspaceAccessException } from './no-workspace-access.exception';
import { AuthService } from './auth.service';
import {
  clearOrgEntitlementCacheForTests,
  EMAIL_OPS_ENTITLEMENTS_TIMEOUT_MS,
} from './org-entitlements.client';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceProvisioningService } from '../workspaces/workspace-provisioning.service';

function makeStore() {
  let user: any = null;
  const workspaces = new Map<string, any>();
  const memberships = new Map<string, any>();
  const tx = {
    workspace: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return workspaces.get(where.id) ?? null;
        return [...workspaces.values()].find((row) => row.slug === where.slug) ?? null;
      }),
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = workspaces.get(where.id);
        if (existing) return existing;
        const row = { ...create, status: 'active' };
        workspaces.set(row.id, row);
        return row;
      }),
    },
    membership: {
      findUnique: jest.fn(async ({ where }: any) => {
        const key = where.userKey_workspaceId;
        return memberships.get(`${key.userKey}:${key.workspaceId}`) ?? null;
      }),
      findFirst: jest.fn(
        async ({ where }: any) =>
          [...memberships.values()].find((row) => row.userKey === where.userKey) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, createdAt: new Date() };
        memberships.set(`${row.userKey}:${row.workspaceId}`, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const key = where.userKey_workspaceId;
        const row = memberships.get(`${key.userKey}:${key.workspaceId}`)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (!user) return null;
        if (where.keycloakId && user.keycloakId === where.keycloakId) return user;
        if (where.email && user.email === where.email) return user;
        if (where.id && user.id === where.id) return user;
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        user = {
          id: 'fixture-local-user',
          isActive: true,
          lastLoginAt: null,
          ...data,
        };
        return user;
      }),
      update: jest.fn(async ({ data }: any) => {
        user = { ...user, ...data };
        return user;
      }),
      delete: jest.fn(async () => {
        user = null;
        return null;
      }),
    },
    invitation: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (callback: (client: any) => unknown) => callback(tx)),
  } as unknown as PrismaService;
  return { prisma, workspaces, memberships, tx, setUser: (next: User) => (user = next) };
}

function makeStrategy(authService: AuthService): JwtStrategy {
  const strategy = Object.create(JwtStrategy.prototype) as any;
  strategy.authService = authService;
  strategy.realmIssuer = 'https://auth.example.test/realms/uchub';
  strategy.brigadeTrustedIssuers = new Set<string>();
  strategy.brigadeExpectedAudience = 'email-ops';
  strategy.keycloakEnforceAudience = false;
  strategy.keycloakExpectedAudiences = new Set(['email-ops']);
  strategy.logger = { warn: jest.fn(), log: jest.fn() };
  return strategy as JwtStrategy;
}

describe('entitled workspace auth wiring', () => {
  const envKeys = [
    'EMAIL_OPS_ENTITLEMENTS_ENABLED',
    'UC_ENTITLEMENTS_URL',
    'EMAIL_OPS_ENTITLEMENT_FEATURE_KEY',
    'BRIGADE_TRUSTED_ISSUERS',
    'EMAIL_OPS_ACCESS_LIST',
  ];
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  const previousFetch = global.fetch;

  beforeEach(() => {
    process.env.EMAIL_OPS_ENTITLEMENTS_ENABLED = 'true';
    process.env.UC_ENTITLEMENTS_URL = 'https://ops.example.test/api/v1/entitlements';
    process.env.EMAIL_OPS_ENTITLEMENT_FEATURE_KEY = 'email_ops_access';
    process.env.BRIGADE_TRUSTED_ISSUERS = '';
    process.env.EMAIL_OPS_ACCESS_LIST = '';
    clearOrgEntitlementCacheForTests();
    jest.clearAllMocks();
  });

  afterEach(() => {
    clearOrgEntitlementCacheForTests();
    for (const key of envKeys) {
      const prior = previousEnv.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    global.fetch = previousFetch;
  });

  it('flag off leaves the existing bearer path untouched and does not call Ops-Center', async () => {
    process.env.EMAIL_OPS_ENTITLEMENTS_ENABLED = 'false';
    const store = makeStore();
    const existing = {
      id: 'fixture-local-user',
      keycloakId: 'fixture-human-sub',
      email: 'human@lantern-harbor.example',
      username: 'human',
      isActive: true,
    } as User;
    store.setUser(existing);
    const auth = new AuthService(
      {} as any,
      store.prisma,
      new WorkspaceProvisioningService(store.prisma),
    );
    const fetchImpl = jest.fn();
    global.fetch = fetchImpl as unknown as typeof fetch;

    await makeStrategy(auth).validate(
      { headers: { authorization: 'Bearer fixture-human-bearer' } } as any,
      {
        iss: 'https://auth.example.test/realms/uchub',
        sub: 'fixture-human-sub',
        email: existing.email,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.workspaces.size).toBe(0);
    expect(store.memberships.size).toBe(0);
  });

  it('entitled human bearer provisions the org workspace and membership', async () => {
    const orgId = '6e40af62-214d-4155-86f1-37dea8bcc53b';
    const store = makeStore();
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            org_id: orgId,
            org_name: 'Lantern Harbor Advisory',
            tier: 'shared',
            role: 'owner',
            entitlements: ['email_ops_access'],
          }),
        }) as Response,
    );
    global.fetch = fetchImpl as unknown as typeof fetch;
    const auth = new AuthService(
      {} as any,
      store.prisma,
      new WorkspaceProvisioningService(store.prisma),
    );

    await makeStrategy(auth).validate(
      { headers: { authorization: 'Bearer fixture-human-bearer' } } as any,
      {
        iss: 'https://auth.example.test/realms/uchub',
        sub: 'fixture-human-sub',
        email: 'human@lantern-harbor.example',
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.workspaces.get(orgId)).toMatchObject({
      id: orgId,
      slug: 'org-6e40af62',
      displayName: 'Lantern Harbor Advisory',
    });
    expect(store.memberships.get(`fixture-human-sub:${orgId}`)).toMatchObject({
      role: WorkspaceRole.OWNER,
      status: 'ACTIVE',
    });
  });

  it('does not forward a PAT-shaped bearer to the entitlement client', async () => {
    const store = makeStore();
    const existing = {
      id: 'fixture-local-user',
      keycloakId: 'fixture-human-sub',
      email: 'human@lantern-harbor.example',
      username: 'human',
      isActive: true,
    } as User;
    store.setUser(existing);
    const auth = new AuthService(
      {} as any,
      store.prisma,
      new WorkspaceProvisioningService(store.prisma),
    );
    const fetchImpl = jest.fn();
    global.fetch = fetchImpl as unknown as typeof fetch;

    await makeStrategy(auth).validate(
      { headers: { authorization: 'Bearer eo_pat_fixture' } } as any,
      {
        iss: 'https://auth.example.test/realms/uchub',
        sub: 'fixture-human-sub',
        email: existing.email,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.workspaces.size).toBe(0);
  });

  it('falls back to the access-list gate when first-login workspace provisioning fails', async () => {
    const orgId = '6e40af62-214d-4155-86f1-37dea8bcc53b';
    const store = makeStore();
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            org_id: orgId,
            org_name: 'Lantern Harbor Advisory',
            role: 'owner',
            entitlements: ['email_ops_access'],
          }),
        }) as Response,
    );
    global.fetch = fetchImpl as unknown as typeof fetch;
    const provisioning = {
      ensureEntitledWorkspace: jest.fn().mockRejectedValue(new Error('fixture database outage')),
    };
    const auth = new AuthService({} as any, store.prisma, provisioning as any);

    await expect(
      makeStrategy(auth).validate(
        { headers: { authorization: 'Bearer fixture-human-bearer' } } as any,
        {
          iss: 'https://auth.example.test/realms/uchub',
          sub: 'fixture-unlisted-sub',
          email: 'unlisted@lantern-harbor.example',
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 300,
        },
      ),
    ).rejects.toBeInstanceOf(NoWorkspaceAccessException);

    expect(store.prisma.user.delete).toHaveBeenCalledTimes(1);
    expect(store.workspaces.size).toBe(0);
    expect(store.memberships.size).toBe(0);
  });

  it('keeps the entitlement client deadline bounded', () => {
    expect(EMAIL_OPS_ENTITLEMENTS_TIMEOUT_MS).toBe(5000);
  });
});
