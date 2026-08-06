import { MessageDisposition } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { DispositionService } from './disposition.service';

/**
 * Integration (real verify DB, two workspaces): the disposition overlay upserts
 * (one row per thread, latest triage wins), filters by folder, and is
 * workspace-isolated via the explicit predicate (RLS is inert under the owner
 * role today, so the predicate is the real fence — the hardening-pass lesson).
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

describe('DispositionService (integration)', () => {
  let prisma: PrismaService;
  let svc: DispositionService;
  const A = '0190a000-7e57-7000-8000-00000005d901';
  const B = '0190a000-7e57-7000-8000-00000005d902';

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const [id, slug] of [
      [A, 'ws-disp-a'],
      [B, 'ws-disp-b'],
    ]) {
      await prisma.workspace.upsert({ where: { id }, update: {}, create: { id, slug, displayName: slug } });
    }
    svc = new DispositionService(prisma);
  });

  afterAll(async () => {
    if (prisma) {
      for (const id of [A, B]) {
        await prisma.threadDisposition.deleteMany({ where: { workspaceId: id } });
        await prisma.workspace.deleteMany({ where: { id } });
      }
      await prisma.$disconnect();
    }
  });

  it('set then list; a second set on the same thread UPDATES (no duplicate)', async () => {
    await svc.setDisposition(A, 'uc-a', 'thread-1', MessageDisposition.ARCHIVE);
    let rows = await svc.list(A, 'uc-a');
    expect(rows.find((r) => r.thread_id === 'thread-1')?.disposition).toBe('ARCHIVE');

    await svc.setDisposition(A, 'uc-a', 'thread-1', MessageDisposition.SPAM);
    rows = await svc.list(A, 'uc-a');
    const t1 = rows.filter((r) => r.thread_id === 'thread-1');
    expect(t1).toHaveLength(1);
    expect(t1[0].disposition).toBe('SPAM');
  });

  it('list(folder) filters; getDispositionMap defaults a never-set thread to absent', async () => {
    await svc.setDisposition(A, 'uc-a', 'thread-arch', MessageDisposition.ARCHIVE);
    const archived = await svc.list(A, 'uc-a', MessageDisposition.ARCHIVE);
    expect(archived.every((r) => r.disposition === 'ARCHIVE')).toBe(true);
    expect(archived.find((r) => r.thread_id === 'thread-arch')).toBeTruthy();

    const map = await prisma.withWorkspace(A, 'uc-a', (tx) =>
      svc.getDispositionMap(tx, A, ['thread-arch', 'never-set']),
    );
    expect(map.get('thread-arch')).toBe('ARCHIVE');
    expect(map.has('never-set')).toBe(false);
  });

  it('is workspace-isolated: workspace B cannot see A’s dispositions', async () => {
    await svc.setDisposition(A, 'uc-a', 'thread-secret', MessageDisposition.TRASH);
    const bRows = await svc.list(B, 'uc-b');
    expect(bRows.find((r) => r.thread_id === 'thread-secret')).toBeUndefined();
  });
});
