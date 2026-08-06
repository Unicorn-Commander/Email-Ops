import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { UiCommandKind, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { MembershipService } from '../common/workspace/membership.service';
import { UiCommandService } from './ui-commands.service';
import { UiControlTools } from '../mcp/mcp.tools';

/**
 * Integration locks for the "agent controls the UI" channel (real verify DB).
 * RLS is inert under the verify superuser, so the explicit (workspaceId, ucUid)
 * predicate is the fence — these prove: enqueue → drain round-trip; drain-on-read
 * is at-most-once (a second drain is empty); cross-(workspace, ucUid) isolation;
 * stale (>5min) commands are never replayed; and the UiControlTools tool path
 * resolves the workspace + acting ucUid and enqueues the right kind + payload.
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

describe('UiCommandService + UiControlTools (integration)', () => {
  let prisma: PrismaService;
  let service: UiCommandService;
  let tools: UiControlTools;
  const A = '0190a000-7e57-7000-8000-0000000c0de1';
  const B = '0190a000-7e57-7000-8000-0000000c0de2';
  const KC = 'kc-ui-user';
  const OTHER = 'kc-ui-other';
  let user: User;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, slug] of [
      [A, 'ws-ui-a'],
      [B, 'ws-ui-b'],
    ]) {
      await prisma.workspace.upsert({ where: { id }, update: {}, create: { id, slug, displayName: slug } });
    }
    user = await prisma.user.upsert({
      where: { id: '00000000-0000-4000-8000-0000000000c1' },
      update: { keycloakId: KC },
      create: { id: '00000000-0000-4000-8000-0000000000c1', keycloakId: KC, email: 'ui@c.test', username: 'ui-user' },
    });
    service = new UiCommandService(prisma);
    tools = new UiControlTools(new MembershipService(prisma, new ConfigService()), service);
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const id of [A, B]) await prisma.workspace.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  it('enqueues then drains a command once (drain-on-read is at-most-once)', async () => {
    await service.enqueue(A, KC, UiCommandKind.NAVIGATE, { path: '/mail' });
    const first = await service.drain(A, KC);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'navigate', payload: { path: '/mail' } });
    expect(first[0].id).toBeTruthy();
    // Consumed — a second drain is empty.
    const second = await service.drain(A, KC);
    expect(second).toHaveLength(0);
  });

  it('is isolated by (workspace, ucUid): a stranger / other workspace drains nothing', async () => {
    await service.enqueue(A, KC, UiCommandKind.NOTIFY, { title: 'hi' });
    expect(await service.drain(A, OTHER)).toHaveLength(0); // wrong user
    expect(await service.drain(B, KC)).toHaveLength(0); // wrong workspace
    // The rightful owner still gets it.
    const mine = await service.drain(A, KC);
    expect(mine.map((c) => c.payload.title)).toContain('hi');
  });

  it('never replays a stale (>5min old) command', async () => {
    await prisma.uiCommand.create({
      data: {
        workspaceId: A,
        ucUid: KC,
        kind: UiCommandKind.NOTIFY,
        payload: { title: 'ancient' },
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    await service.enqueue(A, KC, UiCommandKind.NOTIFY, { title: 'fresh' });
    const drained = await service.drain(A, KC);
    expect(drained.map((c) => c.payload.title)).toEqual(['fresh']);
  });

  it('the UiControlTools tool path resolves workspace + ucUid and enqueues the right command', async () => {
    await tools.navigate(user, { workspace_id: A, path: '/agents' });
    await tools.notify(user, { workspace_id: A, title: 'Archived 12 newsletters' });
    await tools.switchSpace(user, { workspace_id: A, space_id: 'all' });

    const drained = await service.drain(A, KC); // ucUidOf(user) === keycloakId === KC
    expect(drained.map((c) => c.kind)).toEqual(['navigate', 'notify', 'switch_space']);
    expect(drained[0].payload).toMatchObject({ path: '/agents' });
    expect(drained[1].payload).toMatchObject({ title: 'Archived 12 newsletters', tone: 'info' });
    expect(drained[2].payload).toMatchObject({ space_id: 'all' });
  });

  it('delete-on-read purges ALL the caller\'s rows (incl. stale), leaving none behind', async () => {
    await prisma.uiCommand.create({
      data: {
        workspaceId: A,
        ucUid: KC,
        kind: UiCommandKind.NOTIFY,
        payload: { title: 'old' },
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      },
    });
    await service.enqueue(A, KC, UiCommandKind.NOTIFY, { title: 'new' });
    const drained = await service.drain(A, KC);
    expect(drained.map((c) => c.payload.title)).toEqual(['new']); // stale not applied
    // …but BOTH rows are gone — the channel never accumulates.
    expect(await prisma.uiCommand.count({ where: { workspaceId: A, ucUid: KC } })).toBe(0);
  });

  it('caps the applied set at MAX_DRAIN so a flood cannot jam the cockpit', async () => {
    for (let i = 0; i < 60; i += 1) {
      await service.enqueue(A, KC, UiCommandKind.NOTIFY, { title: `n${i}` });
    }
    const drained = await service.drain(A, KC);
    expect(drained.length).toBeLessThanOrEqual(50);
    // The whole flood is still purged regardless of the cap.
    expect(await prisma.uiCommand.count({ where: { workspaceId: A, ucUid: KC } })).toBe(0);
  });
});
