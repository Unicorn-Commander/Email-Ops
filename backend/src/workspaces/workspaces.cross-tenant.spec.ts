import { randomUUID } from 'crypto';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { MembershipService } from '../common/workspace/membership.service';
import { WorkspacesService } from './workspaces.service';

/**
 * Integration locks for the multi-org tenancy layer (real verify DB). These
 * prove the app-layer RBAC fence that holds REGARDLESS of EMAIL_OPS_TENANCY_ENABLED
 * (the service resolves the caller's REAL membership role, not the permissive
 * guard role): create-org → OWNER; non-members are fenced out; invite → accept
 * creates the membership at the invited role; an admin cannot invite/grant above
 * their own rank nor act on a higher-ranked member; and an org can never be
 * stranded with zero active owners. All test orgs use a `BTest …` name (slug
 * `btest-…`) and all test users an `@btest.test` email so cleanup is total.
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

describe('WorkspacesService — multi-org RBAC + invitations (integration)', () => {
  let prisma: PrismaService;
  let service: WorkspacesService;
  let membership: MembershipService;
  let seq = 0;

  const makeUser = async (tag: string): Promise<User> => {
    seq += 1;
    return prisma.user.create({
      data: {
        id: randomUUID(),
        keycloakId: `kc-b-${tag}-${seq}`,
        email: `${tag}-${seq}@btest.test`,
        username: `b-${tag}-${seq}`,
      },
    });
  };

  const addMember = (workspaceId: string, user: User, role: WorkspaceRole) =>
    prisma.membership.create({
      data: { userKey: user.keycloakId!, workspaceId, role, status: MembershipStatus.ACTIVE },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    membership = new MembershipService(prisma, new ConfigService());
    service = new WorkspacesService(prisma, membership);
  });

  afterAll(async () => {
    if (!prisma) return;
    // Deleting the workspace cascades to memberships + invitations.
    await prisma.workspace.deleteMany({ where: { slug: { startsWith: 'btest' } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: '@btest.test' } } });
    await prisma.$disconnect();
  });

  it('create-org makes the caller an OWNER (+ default when they had no membership)', async () => {
    const owner = await makeUser('fresh-owner');
    const org = await service.createOrg(owner, { displayName: 'BTest Acme' });
    expect(org.role).toBe('owner');
    expect(org.is_default).toBe(true);
    expect(org.slug.startsWith('btest-acme')).toBe(true);

    const members = await service.listMembers(org.workspace_id, owner);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      role: 'owner',
      status: 'active',
      is_self: true,
      email: owner.email,
    });
  });

  it('a non-member can neither view nor manage the org (real fence)', async () => {
    const owner = await makeUser('owner');
    const stranger = await makeUser('stranger');
    const org = await service.createOrg(owner, { displayName: 'BTest Fenced' });

    await expect(service.listMembers(org.workspace_id, stranger)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      service.invite(org.workspace_id, stranger, { email: 'x@btest.test' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('invite → accept creates the membership at the invited role; the invite then clears', async () => {
    const owner = await makeUser('owner');
    const invitee = await makeUser('invitee');
    const org = await service.createOrg(owner, { displayName: 'BTest Invited' });

    const invite = await service.invite(org.workspace_id, owner, {
      email: invitee.email,
      role: WorkspaceRole.MEMBER,
    });
    expect(invite.token).toBeTruthy();
    expect(invite.role).toBe('member');

    // The invitee sees it as a pending invite (matched by email)…
    const before = await service.listMyInvites(invitee);
    expect(before.map((i) => i.id)).toContain(invite.id);

    // …accepts by token → becomes a MEMBER…
    const joined = await service.acceptInvite(invitee, invite.token!);
    expect(joined.workspace_id).toBe(org.workspace_id);
    expect(joined.role).toBe('member');

    const members = await service.listMembers(org.workspace_id, owner);
    expect(members.find((m) => m.email === invitee.email)?.role).toBe('member');

    // …and the pending invite is gone (now ACCEPTED).
    const after = await service.listMyInvites(invitee);
    expect(after.map((i) => i.id)).not.toContain(invite.id);

    // Re-accepting the same token is rejected (no longer pending).
    await expect(service.acceptInvite(invitee, invite.token!)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('RBAC: a member cannot invite; an admin can, but never above their own rank', async () => {
    const owner = await makeUser('owner');
    const member = await makeUser('member');
    const org = await service.createOrg(owner, { displayName: 'BTest Ranks' });
    await addMember(org.workspace_id, member, WorkspaceRole.MEMBER);

    // A plain member cannot invite.
    await expect(
      service.invite(org.workspace_id, member, { email: 'n@btest.test' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Promote them to ADMIN; now they can invite a MEMBER…
    await service.updateMember(org.workspace_id, owner, member.keycloakId!, {
      role: WorkspaceRole.ADMIN,
    });
    const ok = await service.invite(org.workspace_id, member, {
      email: 'newhire@btest.test',
      role: WorkspaceRole.MEMBER,
    });
    expect(ok.role).toBe('member');

    // …but an ADMIN cannot invite/grant an OWNER (above their own rank).
    await expect(
      service.invite(org.workspace_id, member, {
        email: 'usurper@btest.test',
        role: WorkspaceRole.OWNER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an admin cannot modify a higher-ranked member', async () => {
    const owner = await makeUser('owner');
    const admin = await makeUser('admin');
    const org = await service.createOrg(owner, { displayName: 'BTest Outrank' });
    await addMember(org.workspace_id, admin, WorkspaceRole.ADMIN);

    await expect(
      service.updateMember(org.workspace_id, admin, owner.keycloakId!, {
        role: WorkspaceRole.MEMBER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an org can never be stranded with zero active owners', async () => {
    const owner = await makeUser('owner');
    const org = await service.createOrg(owner, { displayName: 'BTest LastOwner' });

    // Demoting / removing the only owner is rejected…
    await expect(
      service.updateMember(org.workspace_id, owner, owner.keycloakId!, {
        role: WorkspaceRole.ADMIN,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.removeMember(org.workspace_id, owner, owner.keycloakId!),
    ).rejects.toBeInstanceOf(BadRequestException);

    // …but with a SECOND owner present, the first can step down.
    const owner2 = await makeUser('owner2');
    await addMember(org.workspace_id, owner2, WorkspaceRole.OWNER);
    const demoted = await service.updateMember(org.workspace_id, owner, owner.keycloakId!, {
      role: WorkspaceRole.ADMIN,
    });
    expect(demoted?.role).toBe('admin');
  });

  it('a member can leave (self-removal); cross-org isolation holds', async () => {
    const owner = await makeUser('owner');
    const member = await makeUser('member');
    const orgA = await service.createOrg(owner, { displayName: 'BTest IsoA' });
    const orgB = await service.createOrg(owner, { displayName: 'BTest IsoB' });
    await addMember(orgA.workspace_id, member, WorkspaceRole.MEMBER);

    // The member is in A but not B → cannot view B.
    await expect(service.listMembers(orgB.workspace_id, member)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    // The member leaves A (self-removal, allowed for any member).
    expect(await service.removeMember(orgA.workspace_id, member, member.keycloakId!)).toBe(true);
    const remaining = await service.listMembers(orgA.workspace_id, owner);
    expect(remaining.map((m) => m.email)).not.toContain(member.email);
  });

  it('binds invite acceptance to the invited email (a leaked token can\'t be redeemed by another account)', async () => {
    const owner = await makeUser('owner');
    const invitee = await makeUser('invitee');
    const stranger = await makeUser('stranger');
    const org = await service.createOrg(owner, { displayName: 'BTest EmailBind' });
    const invite = await service.invite(org.workspace_id, owner, {
      email: invitee.email,
      role: WorkspaceRole.MEMBER,
    });
    // A different authenticated account holding the token cannot redeem it.
    await expect(service.acceptInvite(stranger, invite.token!)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // The invited email can.
    const joined = await service.acceptInvite(invitee, invite.token!);
    expect(joined.workspace_id).toBe(org.workspace_id);
  });

  it('refuses to re-invite a suspended member (no silent reactivation back door)', async () => {
    const owner = await makeUser('owner');
    const member = await makeUser('member');
    const org = await service.createOrg(owner, { displayName: 'BTest Suspend' });
    await addMember(org.workspace_id, member, WorkspaceRole.MEMBER);
    await service.updateMember(org.workspace_id, owner, member.keycloakId!, {
      status: MembershipStatus.SUSPENDED,
    });
    // Re-inviting their email is refused — the admin must reactivate explicitly.
    await expect(
      service.invite(org.workspace_id, owner, { email: member.email }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
