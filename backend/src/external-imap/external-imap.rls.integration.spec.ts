import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { TEST_DATABASE_URL } from '../../test/test-db';

describe('external IMAP credential row-level security (Postgres)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const ownerKey = randomUUID();
  const mailboxId = randomUUID();
  const otherMailboxId = randomUUID();

  beforeAll(async () => {
    await prisma.$connect();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await prisma.workspace.create({
        data: { id, slug: id, displayName: 'Example IMAP workspace' },
      });
    }
    for (const [id, workspace] of [
      [mailboxId, workspaceId],
      [otherMailboxId, otherWorkspaceId],
    ]) {
      await prisma.mailboxAccount.create({
        data: {
          id,
          workspaceId: workspace,
          emailAddress: `${id}@example.com`,
          provider: 'external_imap',
          ownerKind: 'HUMAN',
          ownerKey,
        },
      });
    }
    await prisma.externalImapAccount.create({
      data: {
        mailboxId,
        host: 'imap.example.com',
        username: 'owner@example.com',
        // Opaque fixture only: this suite never decrypts or returns credentials.
        encryptedPassword: 'synthetic-ciphertext',
      },
    });
  });

  afterAll(async () => {
    try {
      await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  // Seed/cleanup use the harness administrator. Every assertion about row
  // access runs as the real NOBYPASSRLS runtime role in a local transaction.
  function asRuntime<T>(
    workspace: string | null,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE email_ops_app`;
      expect(
        await tx.$queryRaw`
          SELECT current_user AS role, rolsuper, rolbypassrls
          FROM pg_roles WHERE rolname = current_user
        `,
      ).toEqual([{ role: 'email_ops_app', rolsuper: false, rolbypassrls: false }]);
      await tx.$executeRaw`SELECT set_config('app.current_workspace', ${workspace ?? ''}, true)`;
      await tx.$executeRaw`SELECT set_config('app.uc_uid', ${ownerKey}, true)`;
      return fn(tx);
    });
  }

  const readCredentialIds = (tx: Prisma.TransactionClient) =>
    tx.externalImapAccount.findMany({
      where: { mailboxId },
      select: { mailboxId: true },
    });

  it('enables and forces RLS and grants runtime DML plus reporting SELECT', async () => {
    const [security] = await prisma.$queryRaw<
      {
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        runtime: boolean;
        reporting: boolean;
      }[]
    >`
      SELECT relrowsecurity, relforcerowsecurity,
        has_table_privilege('email_ops_app', oid, 'SELECT')
          AND has_table_privilege('email_ops_app', oid, 'INSERT')
          AND has_table_privilege('email_ops_app', oid, 'UPDATE')
          AND has_table_privilege('email_ops_app', oid, 'DELETE') AS runtime,
        has_table_privilege('email_ops_ro', oid, 'SELECT') AS reporting
      FROM pg_class WHERE oid = 'external_imap_accounts'::regclass
    `;
    expect(security).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      runtime: true,
      reporting: true,
    });
  });

  it('returns zero rows in another workspace even with the same owner', async () => {
    expect(await asRuntime(otherWorkspaceId, readCredentialIds)).toEqual([]);
  });

  it('lets the owner read its row in the parent mailbox workspace', async () => {
    expect(await asRuntime(workspaceId, readCredentialIds)).toEqual([{ mailboxId }]);
  });

  it('returns zero rows without workspace context, including after an authorized read', async () => {
    await asRuntime(workspaceId, readCredentialIds);
    await asRuntime(null, async (tx) => {
      expect(await tx.$queryRaw`SELECT current_workspace_id() AS workspace`).toEqual([
        { workspace: null },
      ]);
      expect(await readCredentialIds(tx)).toEqual([]);
    });
  });

  it('prevents cross-workspace updates and deletes', async () => {
    await asRuntime(otherWorkspaceId, async (tx) => {
      expect(
        await tx.externalImapAccount.updateMany({
          where: { mailboxId },
          data: { host: 'changed.example.com' },
        }),
      ).toEqual({ count: 0 });
      expect(await tx.externalImapAccount.deleteMany({ where: { mailboxId } })).toEqual({
        count: 0,
      });
    });
    expect(await asRuntime(workspaceId, readCredentialIds)).toEqual([{ mailboxId }]);
  });

  it('rejects inserting credentials for a foreign mailbox', async () => {
    await expect(
      asRuntime(
        workspaceId,
        (tx) =>
          tx.$executeRaw`
          INSERT INTO external_imap_accounts ("mailboxId", host, username, "encryptedPassword")
          VALUES (${otherMailboxId}, 'imap.example.com', 'other@example.com', 'synthetic-ciphertext')
        `,
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
  });

  it('rejects moving credentials to a foreign mailbox', async () => {
    await expect(
      asRuntime(
        workspaceId,
        (tx) =>
          tx.$executeRaw`
          UPDATE external_imap_accounts SET "mailboxId" = ${otherMailboxId}
          WHERE "mailboxId" = ${mailboxId}
        `,
      ),
    ).rejects.toMatchObject({ code: 'P2010', meta: { code: '42501' } });
    expect(await asRuntime(workspaceId, readCredentialIds)).toEqual([{ mailboxId }]);
  });
});
