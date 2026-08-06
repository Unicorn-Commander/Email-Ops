import { SenderPolicyKind, SenderPolicyScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { SenderPolicyService } from './sender-policy.service';

/**
 * Integration (real verify DB, two workspaces): the block/allow list upserts on
 * (scope, pattern), normalizes domains, evaluates address-over-domain, and is
 * workspace-isolated via the explicit predicate.
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

describe('SenderPolicyService (integration)', () => {
  let prisma: PrismaService;
  let svc: SenderPolicyService;
  const A = '0190a000-7e57-7000-8000-00000005e901';
  const B = '0190a000-7e57-7000-8000-00000005e902';
  const evalIn = (ws: string, addr: string) =>
    prisma.withWorkspace(ws, 'uc', (tx) => svc.evaluate(tx, ws, addr));

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, slug] of [
      [A, 'ws-sp-a'],
      [B, 'ws-sp-b'],
    ]) {
      await prisma.workspace.upsert({ where: { id }, update: {}, create: { id, slug, displayName: slug } });
    }
    svc = new SenderPolicyService(prisma);
  });

  afterAll(async () => {
    if (prisma) {
      for (const id of [A, B]) {
        await prisma.senderPolicy.deleteMany({ where: { workspaceId: id } });
        await prisma.workspace.deleteMany({ where: { id } });
      }
      await prisma.$disconnect();
    }
  });

  it('set + list; flipping kind on the same (scope,pattern) UPDATES (no duplicate)', async () => {
    await svc.set(A, 'uc-a', { scope: SenderPolicyScope.ADDRESS, pattern: 'bob@x.com', kind: SenderPolicyKind.BLOCK });
    await svc.set(A, 'uc-a', { scope: SenderPolicyScope.ADDRESS, pattern: 'bob@x.com', kind: SenderPolicyKind.ALLOW });
    const bob = (await svc.list(A, 'uc-a')).filter((r) => r.pattern === 'bob@x.com');
    expect(bob).toHaveLength(1);
    expect(bob[0].kind).toBe('ALLOW');
  });

  it('normalizes domains (lowercase, strip @) and evaluates address-over-domain', async () => {
    await svc.set(A, 'uc-a', { scope: SenderPolicyScope.DOMAIN, pattern: '@Evil.COM', kind: SenderPolicyKind.BLOCK });
    await svc.set(A, 'uc-a', { scope: SenderPolicyScope.ADDRESS, pattern: 'ok@evil.com', kind: SenderPolicyKind.ALLOW });

    const stored = (await svc.list(A, 'uc-a')).find((r) => r.scope === 'DOMAIN');
    expect(stored?.pattern).toBe('evil.com');

    expect(await evalIn(A, 'OK@evil.com')).toBe('ALLOW'); // exact address wins over the domain
    expect(await evalIn(A, 'rando@evil.com')).toBe('BLOCK'); // falls through to the domain rule
    expect(await evalIn(A, 'nobody@good.com')).toBeNull();
  });

  it('remove returns true on hit / false on miss; evaluate is workspace-isolated', async () => {
    const rule = await svc.set(A, 'uc-a', {
      scope: SenderPolicyScope.ADDRESS,
      pattern: 'gone@x.com',
      kind: SenderPolicyKind.BLOCK,
    });
    expect(await svc.remove(A, 'uc-a', rule.id)).toBe(true);
    expect(await svc.remove(A, 'uc-a', 'nonexistent')).toBe(false);

    await svc.set(B, 'uc-b', { scope: SenderPolicyScope.ADDRESS, pattern: 'bspam@x.com', kind: SenderPolicyKind.BLOCK });
    expect(await evalIn(A, 'bspam@x.com')).toBeNull(); // B's rule is invisible to A
  });
});
