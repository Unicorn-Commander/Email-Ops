import { MailboxAccessLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TEST_DATABASE_URL } from '../../test/test-db';
import { AgentsService } from './agents.service';

/**
 * Multi-mailbox bindings (integration, against the verify DB). Proves the
 * AgentMailbox join + the invariant the send-resolver depends on: exactly one
 * primary per agent, Agent.mailboxAccountId mirrors it, and unbinding the primary
 * repoints the cache to another sendable binding. Distinct workspace so it runs
 * safely in parallel with the other integration specs.
 */
// Integration DB URL (verify Postgres). Overridable via TEST_DATABASE_URL (CI service container);
// defaults to the historical verify DB so local runs are unchanged.
const DB_URL = TEST_DATABASE_URL;

describe('AgentsService — multi-mailbox bindings (integration)', () => {
  let prisma: PrismaService;
  let svc: AgentsService;
  const WS = '0190a000-7e57-7000-8000-00000000ab01';
  const UID = 'uc-uid-bindings';

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new AgentsService(prisma);
    await prisma.workspace.upsert({
      where: { id: WS },
      update: {},
      create: { id: WS, slug: `ws-bind-${WS.slice(-6)}`, displayName: 'Bindings test ws' },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.agentMailbox.deleteMany({ where: { workspaceId: WS } });
      await prisma.agentActionEvent.deleteMany({ where: { workspaceId: WS } });
      await prisma.agent.deleteMany({ where: { workspaceId: WS } });
      await prisma.mailboxAccount.deleteMany({ where: { workspaceId: WS } });
      await prisma.workspace.deleteMany({ where: { id: WS } });
      await prisma.$disconnect();
    }
  });

  it('binds mailboxes, maintains the primary + cache, and repoints on unbind', async () => {
    const mbA = await prisma.mailboxAccount.create({
      data: { workspaceId: WS, emailAddress: 'a@bind.test', isDefault: false },
    });
    const mbB = await prisma.mailboxAccount.create({
      data: { workspaceId: WS, emailAddress: 'b@bind.test', isDefault: false },
    });
    const agent = await prisma.agent.create({
      data: { workspaceId: WS, key: 'binder', displayName: 'Binder' },
    });

    // Bind A as primary → cache = A, A primary.
    let view = await svc.bindMailbox(WS, UID, agent.id, { mailboxAccountId: mbA.id, isPrimary: true });
    expect(view?.mailbox_account_id).toBe(mbA.id);
    expect(view?.mailboxes.find((m) => m.mailbox_account_id === mbA.id)?.is_primary).toBe(true);

    // Bind B (READ, non-primary) → two bindings, cache unchanged.
    view = await svc.bindMailbox(WS, UID, agent.id, {
      mailboxAccountId: mbB.id,
      access: MailboxAccessLevel.READ,
    });
    expect(view?.mailbox_account_id).toBe(mbA.id);
    expect(view?.mailboxes).toHaveLength(2);
    expect(view?.mailboxes.find((m) => m.mailbox_account_id === mbB.id)?.is_primary).toBe(false);

    // Promote B to primary → cache = B, A demoted, B sendable.
    view = await svc.bindMailbox(WS, UID, agent.id, { mailboxAccountId: mbB.id, isPrimary: true });
    expect(view?.mailbox_account_id).toBe(mbB.id);
    expect(view?.mailboxes.find((m) => m.mailbox_account_id === mbB.id)?.is_primary).toBe(true);
    expect(view?.mailboxes.find((m) => m.mailbox_account_id === mbA.id)?.is_primary).toBe(false);
    const bAccess = view?.mailboxes.find((m) => m.mailbox_account_id === mbB.id)?.access;
    expect(['SEND', 'BOTH']).toContain(bAccess);

    // Unbind the primary (B) → cache repoints to A (the remaining sendable).
    view = await svc.unbindMailbox(WS, UID, agent.id, mbB.id);
    expect(view?.mailbox_account_id).toBe(mbA.id);
    expect(view?.mailboxes).toHaveLength(1);
    expect(view?.mailboxes[0].mailbox_account_id).toBe(mbA.id);
    expect(view?.mailboxes[0].is_primary).toBe(true);

    // Grants + the revoke were audited.
    const granted = await prisma.agentActionEvent.count({
      where: { workspaceId: WS, kind: 'MAILBOX_ACCESS_GRANTED' },
    });
    expect(granted).toBeGreaterThanOrEqual(3);
    const revoked = await prisma.agentActionEvent.count({
      where: { workspaceId: WS, kind: 'MAILBOX_ACCESS_REVOKED' },
    });
    expect(revoked).toBe(1);
  });
});
