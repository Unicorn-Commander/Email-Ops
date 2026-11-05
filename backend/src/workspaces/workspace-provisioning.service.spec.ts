import { MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';

function makePrisma(seed: { workspaces?: any[]; memberships?: any[] } = {}) {
  const workspaces = new Map<string, any>(
    (seed.workspaces ?? []).map((row) => [row.id, { ...row }]),
  );
  const memberships = new Map<string, any>(
    (seed.memberships ?? []).map((row) => [`${row.userKey}:${row.workspaceId}`, { ...row }]),
  );
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
      findFirst: jest.fn(async ({ where }: any) => {
        return [...memberships.values()].find((row) => row.userKey === where.userKey) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          ...data,
          createdAt: new Date(),
        };
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
    $transaction: jest.fn(async (callback: (client: any) => unknown) => callback(tx)),
  } as unknown as PrismaService;
  return { prisma, tx, workspaces, memberships };
}

const user = (id: string, keycloakId: string) =>
  ({ id, keycloakId, email: `${id}@example.test` }) as User;

describe('WorkspaceProvisioningService.ensureEntitledWorkspace', () => {
  const orgId = '6e40af62-214d-4155-86f1-37dea8bcc53b';

  it('creates an org-id workspace and an OWNER membership', async () => {
    const { prisma, workspaces, memberships } = makePrisma();
    const service = new WorkspaceProvisioningService(prisma);

    const result = await service.ensureEntitledWorkspace({
      user: user('fixture-owner', 'fixture-owner-sub'),
      entitlement: { orgId, orgName: 'Lantern Harbor Advisory', role: 'owner' },
    });

    expect(result.workspaceId).toBe(orgId);
    expect(workspaces.get(orgId)).toMatchObject({
      id: orgId,
      slug: 'org-6e40af62',
      displayName: 'Lantern Harbor Advisory',
    });
    expect(memberships.get(`fixture-owner-sub:${orgId}`)).toMatchObject({
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      isDefault: true,
    });
  });

  it('is idempotent, preserves the first display name, and never demotes a role', async () => {
    const { prisma, tx, workspaces, memberships } = makePrisma();
    const service = new WorkspaceProvisioningService(prisma);
    const owner = user('fixture-owner', 'fixture-owner-sub');

    await service.ensureEntitledWorkspace({
      user: owner,
      entitlement: { orgId, orgName: 'Lantern Harbor Advisory', role: 'owner' },
    });
    const second = await service.ensureEntitledWorkspace({
      user: owner,
      entitlement: { orgId, orgName: 'A changed name', role: 'member' },
    });

    expect(second.membership.role).toBe(WorkspaceRole.OWNER);
    expect(workspaces.get(orgId)?.displayName).toBe('Lantern Harbor Advisory');
    expect(memberships.size).toBe(1);
    expect(tx.membership.create).toHaveBeenCalledTimes(1);
    expect(tx.membership.update).not.toHaveBeenCalled();
  });

  it('maps non-owner entitlement roles to MEMBER and does not touch another workspace', async () => {
    const otherWorkspace = { id: 'other-workspace', slug: 'other-workspace', displayName: 'Other' };
    const otherMembership = {
      userKey: 'fixture-member-sub',
      workspaceId: otherWorkspace.id,
      role: WorkspaceRole.ADMIN,
      status: MembershipStatus.ACTIVE,
      isDefault: true,
    };
    const { prisma, memberships } = makePrisma({
      workspaces: [otherWorkspace],
      memberships: [otherMembership],
    });
    const service = new WorkspaceProvisioningService(prisma);

    const result = await service.ensureEntitledWorkspace({
      user: user('fixture-member', 'fixture-member-sub'),
      entitlement: { orgId, role: 'member' },
    });

    expect(result.membership.role).toBe(WorkspaceRole.MEMBER);
    expect(result.membership.isDefault).toBe(false);
    expect(memberships.get(`fixture-member-sub:${otherWorkspace.id}`)).toMatchObject({
      role: WorkspaceRole.ADMIN,
      isDefault: true,
    });
  });

  it('uses an incremented slug when org-<id8> is already taken', async () => {
    const taken = { id: 'other-org', slug: 'org-6e40af62', displayName: 'Existing Org' };
    const { prisma, workspaces } = makePrisma({ workspaces: [taken] });
    const service = new WorkspaceProvisioningService(prisma);

    await service.ensureEntitledWorkspace({
      user: user('fixture-member', 'fixture-member-sub'),
      entitlement: { orgId, role: 'member' },
    });

    expect(workspaces.get(orgId)?.slug).toBe('org-6e40af62-2');
    expect(workspaces.get('other-org')?.slug).toBe('org-6e40af62');
  });
});
