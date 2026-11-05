import { createHash } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { InvitationStatus, MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { WorkspacesService } from './workspaces.service';

const WORKSPACE_ID = 'workspace-example';

const owner = {
  id: 'user-owner',
  keycloakId: 'subject-owner',
  email: 'owner@example.com',
  username: 'owner',
} as User;

const invitee = {
  id: 'user-invitee',
  keycloakId: 'subject-invitee',
  email: 'invitee@example.com',
  username: 'invitee',
} as User;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'invite-1',
    workspaceId: WORKSPACE_ID,
    email: invitee.email,
    role: WorkspaceRole.MEMBER,
    tokenHash: hash('old-example-token'),
    status: InvitationStatus.PENDING,
    invitedByKey: owner.keycloakId,
    createdAt: new Date('2026-11-05T06:00:00.000Z'),
    expiresAt: new Date('2026-11-19T06:00:00.000Z'),
    acceptedAt: null,
    acceptedByKey: null,
    ...overrides,
  };
}

function makeService(row = invitation()) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    invitation: {
      findFirst: jest.fn().mockResolvedValue(row),
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      })),
    },
    workspace: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: WORKSPACE_ID,
        slug: 'example-workspace',
        displayName: 'Example Workspace',
        status: 'active',
      }),
    },
    membership: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        userKey: invitee.keycloakId,
        role: WorkspaceRole.MEMBER,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      }),
    },
  };
  const prisma = {
    membership: {
      findFirst: jest.fn().mockResolvedValue({
        role: WorkspaceRole.ADMIN,
        status: MembershipStatus.ACTIVE,
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([owner]),
    },
    invitation: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([row]),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...invitation(),
        ...data,
      })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      })),
    },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const membership = {
    findWorkspaces: jest.fn().mockResolvedValue([
      { id: WORKSPACE_ID, displayName: 'Example Workspace' },
    ]),
  };
  return {
    service: new WorkspacesService(prisma as never, membership as never),
    prisma,
    tx,
  };
}

describe('WorkspacesService invitation capabilities', () => {
  it('hashes a newly-created token and never returns it from the admin list', async () => {
    const { service, prisma } = makeService();

    const created = await service.invite(WORKSPACE_ID, owner, {
      email: invitee.email,
      role: WorkspaceRole.MEMBER,
    });
    const createData = prisma.invitation.create.mock.calls[0][0].data as Record<string, unknown>;

    expect(created.token).toBeTruthy();
    expect(createData.tokenHash).toBe(hash(created.token!));
    expect(createData).not.toHaveProperty('token');

    const listed = await service.listInvites(WORKSPACE_ID, owner);
    expect(listed[0]).toMatchObject({ token: null, can_reissue: true });
    expect(listed[0]).not.toHaveProperty('tokenHash');
  });

  it('accepts the raw token by hash and rejects a wrong token without querying cleartext', async () => {
    const raw = 'old-example-token';
    const { service, tx } = makeService(invitation({ tokenHash: hash(raw) }));

    await expect(service.acceptInvite(invitee, raw)).resolves.toMatchObject({
      workspace_id: WORKSPACE_ID,
      role: 'member',
    });
    expect(tx.invitation.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hash(raw) } });

    tx.invitation.findUnique.mockResolvedValueOnce(null);
    await expect(service.acceptInvite(invitee, 'wrong-example-token')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.invitation.findUnique).toHaveBeenLastCalledWith({
      where: { tokenHash: hash('wrong-example-token') },
    });
  });

  it('reissues a pending invitation, rotates its hash, and invalidates the old token', async () => {
    const oldToken = 'old-example-token';
    const { service, prisma, tx } = makeService(invitation({ tokenHash: hash(oldToken) }));

    const refreshed = await service.reissueInvite(WORKSPACE_ID, owner, 'invite-1');
    const updateData = tx.invitation.update.mock.calls[0][0].data as Record<string, unknown>;

    expect(refreshed?.token).toBeTruthy();
    expect(refreshed?.token).not.toBe(oldToken);
    expect(updateData.tokenHash).toBe(hash(refreshed!.token!));
    expect(updateData.tokenHash).not.toBe(hash(oldToken));
    expect(refreshed?.can_reissue).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    tx.invitation.findUnique.mockResolvedValueOnce(null);
    await expect(service.acceptInvite(invitee, oldToken)).rejects.toBeInstanceOf(NotFoundException);
  });
});
