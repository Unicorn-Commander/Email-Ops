import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspaceProvisioningService } from './workspace-provisioning.service';

function makePrisma(seed: any[] = []) {
  const rows = new Map(seed.map((row) => [row.id, { ...row }]));
  const prisma: any = {
    workspace: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.opsCenterOrgId) {
          return (
            [...rows.values()].find((row) => row.opsCenterOrgId === where.opsCenterOrgId) ?? null
          );
        }
        if (where.slug) return [...rows.values()].find((row) => row.slug === where.slug) ?? null;
        return rows.get(where.id) ?? null;
      }),
      findMany: jest.fn(async () => [...rows.values()]),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
        rows.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  return { prisma, rows };
}

const org = '0190a000-7e57-7000-8000-00000000abcd';

describe('WorkspaceProvisioningService', () => {
  it('upserts by Ops-Center org and returns the same workspace id', async () => {
    const { prisma } = makePrisma();
    const service = new WorkspaceProvisioningService(prisma);
    const first = await service.createOrGet({ orgId: org, displayName: 'Lantern Harbor' });
    const second = await service.createOrGet({ orgId: org, displayName: 'Changed Name' });

    expect(second.workspace_id).toBe(first.workspace_id);
    expect(second.display_name).toBe('Lantern Harbor');
    expect(prisma.workspace.create).toHaveBeenCalledTimes(1);
  });

  it('reads suspended workspaces but refuses metadata writes with a problem response', async () => {
    const { prisma } = makePrisma([
      {
        id: 'workspace-1',
        opsCenterOrgId: org,
        slug: 'lantern-harbor',
        displayName: 'Lantern Harbor',
        status: 'suspended',
      },
    ]);
    const service = new WorkspaceProvisioningService(prisma);
    await expect(service.get(org)).resolves.toMatchObject({ status: 'suspended' });
    await expect(service.patch({ orgId: org, displayName: 'Nope' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    try {
      await service.patch({ orgId: org, displayName: 'Nope' });
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        type: expect.stringContaining('/problems/workspace-inactive'),
        status: 403,
        workspace_status: 'suspended',
      });
    }
  });

  it('returns 404 for an unknown organization', async () => {
    const { prisma } = makePrisma();
    await expect(new WorkspaceProvisioningService(prisma).get(org)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
