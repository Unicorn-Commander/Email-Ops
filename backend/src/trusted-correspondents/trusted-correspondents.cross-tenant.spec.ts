import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TrustedCorrespondentsService } from './trusted-correspondents.service';
import { TEST_DATABASE_URL } from '../../test/test-db';

/**
 * Wave 7 — trusted_correspondents cross-tenant fence (integration, real verify
 * DB, two workspaces — mirrors email.cross-tenant.spec.ts):
 *
 *   - a caller scoped to workspace A must NOT see workspace B's trust rows
 *     (they would leak who B's agents talk to — a straight contact-graph leak);
 *   - a caller scoped to A must NOT delete B's rows (that would silently
 *     LOOSEN nothing / TIGHTEN B's autonomy without B's consent);
 *   - the same-address trust rows of A and B are INDEPENDENT rows.
 *
 * RLS is inert under the owner role today, so the explicit workspaceId fence in
 * the service is the real guard these specs pin; the migration's ENABLE+FORCE
 * policy (workspace_isolation) is proven by prisma/rls-acceptance.sql under the
 * NOBYPASSRLS runtime role, like every other scoped table.
 */

const DB_URL = TEST_DATABASE_URL;

describe('TrustedCorrespondentsService — cross-tenant fence (integration)', () => {
  let prisma: PrismaService;
  let service: TrustedCorrespondentsService;
  const A = '0190a000-7e57-7000-8000-00000000tc0a'.replace('tc', '1c');
  const B = '0190a000-7e57-7000-8000-00000000tc0b'.replace('tc', '1c');

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, slug] of [
      [A, 'ws-tc-a'],
      [B, 'ws-tc-b'],
    ]) {
      await prisma.workspace.upsert({
        where: { id },
        update: {},
        create: { id, slug, displayName: slug },
      });
    }
    service = new TrustedCorrespondentsService(prisma);
  });

  afterAll(async () => {
    if (prisma) {
      for (const id of [A, B]) {
        await prisma.trustedCorrespondent.deleteMany({ where: { workspaceId: id } });
        await prisma.workspace.deleteMany({ where: { id } });
      }
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    for (const id of [A, B]) {
      await prisma.trustedCorrespondent.deleteMany({ where: { workspaceId: id } });
    }
  });

  it('a caller in A lists ONLY A\'s rows — never B\'s trust graph', async () => {
    await service.add(A, 'uc-a', { address: 'shared@ext.test' });
    await service.add(B, 'uc-b', { address: 'b-only@ext.test' });

    const forA = await service.list(A, 'uc-a');
    expect(forA.map((r) => r.address)).toEqual(['shared@ext.test']);
    const forB = await service.list(B, 'uc-b');
    expect(forB.map((r) => r.address)).toEqual(['b-only@ext.test']);
  });

  it('a caller in A cannot DELETE a row that lives in B (by id OR by address)', async () => {
    const bRow = await service.add(B, 'uc-b', { address: 'target@ext.test' });

    // By id: the fenced deleteMany matches zero rows → false (→ 404 upstream).
    expect(await service.remove(A, 'uc-a', bRow.id)).toBe(false);
    // By address: A has no such row; B's must not be touched.
    expect(await service.removeByAddress(A, 'uc-a', 'target@ext.test')).toBe(false);

    const still = await prisma.trustedCorrespondent.findUnique({
      where: {
        workspaceId_scope_address: {
          workspaceId: B,
          scope: 'ADDRESS',
          address: 'target@ext.test',
        },
      },
    });
    expect(still).toBeTruthy();
  });

  it('the same address trusted in BOTH workspaces is two independent rows', async () => {
    await service.add(A, 'uc-a', { address: 'both@ext.test', note: 'a-note' });
    await service.add(B, 'uc-b', { address: 'both@ext.test', note: 'b-note' });

    expect(await service.removeByAddress(A, 'uc-a', 'both@ext.test')).toBe(true);
    // B's row survives A's untrust.
    const bRows = await service.list(B, 'uc-b');
    expect(bRows.map((r) => r.address)).toEqual(['both@ext.test']);
    expect(bRows[0].note).toBe('b-note');
  });

  it('normalizes + validates: "Name <ADDR>" forms are stored bare-lowercase; junk is rejected', async () => {
    const row = await service.add(A, 'uc-a', { address: 'Jane Doe <Jane@EXT.test>' });
    expect(row.address).toBe('jane@ext.test');
    expect(row.scope).toBe('ADDRESS');
    expect(row.source).toBe('MANUAL');
    await expect(service.add(A, 'uc-a', { address: 'not-an-email' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('Wave 10: infers DOMAIN scope from a bare domain, strips a leading @, and ADDRESS+DOMAIN coexist', async () => {
    const dom = await service.add(A, 'uc-a', { address: '@Acme.COM' });
    expect(dom.address).toBe('acme.com');
    expect(dom.scope).toBe('DOMAIN');

    // An explicit address at the same domain is an independent row (distinct scope).
    const addr = await service.add(A, 'uc-a', { address: 'jane@acme.com' });
    expect(addr.scope).toBe('ADDRESS');
    const rows = await service.list(A, 'uc-a');
    expect(rows.filter((r) => r.address.endsWith('acme.com')).length).toBe(2);

    // An explicit scope:'domain' on a bare token is honored; junk domain rejected.
    const d2 = await service.add(A, 'uc-a', { address: 'beta.io', scope: 'domain' });
    expect(d2.scope).toBe('DOMAIN');
    await expect(service.add(A, 'uc-a', { address: 'nodomain', scope: 'domain' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Untrust by bare domain removes the DOMAIN row, leaving the ADDRESS row.
    expect(await service.removeByAddress(A, 'uc-a', 'acme.com')).toBe(true);
    const after = await service.list(A, 'uc-a');
    expect(after.some((r) => r.address === 'acme.com')).toBe(false);
    expect(after.some((r) => r.address === 'jane@acme.com')).toBe(true);
  });
});
