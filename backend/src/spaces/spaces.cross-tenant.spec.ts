import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { SpaceVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { SpacesService } from './spaces.service';

/**
 * Integration locks for the Spaces visibility + isolation model (real verify DB,
 * two workspaces). RLS is inert under the owner role today, so the explicit
 * workspaceId predicate + the app-layer ownerKey fence are the real guards —
 * these prove both:
 *   - a PERSONAL space is invisible to a different ucUid; a TEAM space is visible
 *     to every member.
 *   - the keycloakId-OR-User.id owner match (a PERSONAL space created while the
 *     caller arrives as the local User.id is still owned by the caller arriving
 *     as their keycloakId, and vice versa).
 *   - cross-tenant isolation (a space in A is invisible + un-actionable from B).
 *   - PERSONAL owner-only edit/delete; TEAM editable by any member.
 *   - membership REPLACE + foreign-id rejection (mailboxes + agents).
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

describe('SpacesService — visibility, owner fence + cross-tenant (integration)', () => {
  let prisma: PrismaService;
  let service: SpacesService;
  const A = '0190a000-7e57-7000-8000-0000005face1';
  const B = '0190a000-7e57-7000-8000-0000005face2';
  // The owner: a linked User whose keycloakId != local id (the ambiguity under test).
  const UID = '00000000-0000-4000-8000-0000000005a1';
  const KC = 'kc-spaces-owner';
  const STRANGER = 'kc-spaces-stranger';
  let mailboxA: string;
  let mailboxB: string;
  let agentA: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, slug] of [
      [A, 'ws-spaces-a'],
      [B, 'ws-spaces-b'],
    ]) {
      await prisma.workspace.upsert({
        where: { id },
        update: {},
        create: { id, slug, displayName: slug },
      });
    }
    await prisma.user.upsert({
      where: { id: UID },
      update: { keycloakId: KC },
      create: {
        id: UID,
        keycloakId: KC,
        email: 'spaces-owner@xt.test',
        username: 'spaces-owner',
      },
    });
    mailboxA = (
      await prisma.mailboxAccount.create({
        data: { workspaceId: A, emailAddress: 'desk-a@spaces.test', isDefault: true },
      })
    ).id;
    mailboxB = (
      await prisma.mailboxAccount.create({
        data: { workspaceId: B, emailAddress: 'desk-b@spaces.test', isDefault: true },
      })
    ).id;
    agentA = (
      await prisma.agent.create({
        data: { workspaceId: A, key: 'agent-a', displayName: 'Agent A' },
      })
    ).id;
    service = new SpacesService(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const id of [A, B]) {
      // Deleting the workspace cascades to spaces / mailbox_accounts / agents
      // (and the space_* join rows under them).
      await prisma.workspace.deleteMany({ where: { id } });
    }
    await prisma.user.deleteMany({ where: { id: UID } });
    await prisma.$disconnect();
  });

  it('a PERSONAL space is visible to its owner but invisible to a different ucUid', async () => {
    const space = await service.createSpace(A, KC, { name: 'My Personal' });
    expect(space.visibility).toBe('personal');

    const mine = await service.listSpaces(A, KC);
    expect(mine.map((s) => s.id)).toContain(space.id);

    const stranger = await service.listSpaces(A, STRANGER);
    expect(stranger.map((s) => s.id)).not.toContain(space.id);
  });

  it('a TEAM space is visible to every member of the workspace', async () => {
    const team = await service.createSpace(A, KC, { name: 'Shared', visibility: SpaceVisibility.TEAM });
    expect(team.visibility).toBe('team');

    for (const caller of [KC, STRANGER, UID]) {
      const list = await service.listSpaces(A, caller);
      expect(list.map((s) => s.id)).toContain(team.id);
    }
  });

  it('owner match survives the keycloakId-OR-User.id ambiguity (created as local id)', async () => {
    // Create the PERSONAL space while the caller arrives as the LOCAL User.id. The
    // service resolves the user and stamps ownerKey = the canonical keycloakId.
    const space = await service.createSpace(A, UID, { name: 'Ambiguous Owner' });

    // The same person is the owner whether they next arrive as their keycloakId…
    const viaKc = await service.listSpaces(A, KC);
    expect(viaKc.map((s) => s.id)).toContain(space.id);
    // …or as their local User.id.
    const viaId = await service.listSpaces(A, UID);
    expect(viaId.map((s) => s.id)).toContain(space.id);
    // …but NOT to an unrelated ucUid.
    const viaStranger = await service.listSpaces(A, STRANGER);
    expect(viaStranger.map((s) => s.id)).not.toContain(space.id);
  });

  it('is cross-tenant isolated: a space in A is invisible + un-actionable from B', async () => {
    const space = await service.createSpace(A, KC, { name: 'A-only', visibility: SpaceVisibility.TEAM });

    const inB = await service.listSpaces(B, KC);
    expect(inB.map((s) => s.id)).not.toContain(space.id);

    // A foreign id resolves to null/false through workspace B (→ 404 at controller).
    expect(await service.updateSpace(B, KC, space.id, { name: 'hijack' })).toBeNull();
    expect(await service.deleteSpace(B, KC, space.id)).toBe(false);

    // A's row is untouched.
    const stillA = await service.listSpaces(A, KC);
    expect(stillA.find((s) => s.id === space.id)?.name).toBe('A-only');
  });

  it('PERSONAL is owner-only to edit/delete; TEAM is editable by any member', async () => {
    const personal = await service.createSpace(A, KC, { name: 'Owner Guarded' });
    await expect(service.updateSpace(A, STRANGER, personal.id, { name: 'nope' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.deleteSpace(A, STRANGER, personal.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    const team = await service.createSpace(A, KC, { name: 'Team Editable', visibility: SpaceVisibility.TEAM });
    const edited = await service.updateSpace(A, STRANGER, team.id, { name: 'renamed by member' });
    expect(edited?.name).toBe('renamed by member');
  });

  it('replaces membership + rejects foreign mailbox/agent ids', async () => {
    const space = await service.createSpace(A, KC, { name: 'Membership' });

    // Set, then replace the mailbox set.
    let v = await service.setMailboxes(A, KC, space.id, [mailboxA]);
    expect(v?.mailbox_ids).toEqual([mailboxA]);
    v = await service.setMailboxes(A, KC, space.id, []);
    expect(v?.mailbox_ids).toEqual([]);

    // Agents membership.
    v = await service.setAgents(A, KC, space.id, [agentA]);
    expect(v?.agent_ids).toEqual([agentA]);

    // A mailbox/agent from another workspace is rejected (400).
    await expect(service.setMailboxes(A, KC, space.id, [mailboxB])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.setAgents(A, KC, space.id, ['no-such-agent'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
