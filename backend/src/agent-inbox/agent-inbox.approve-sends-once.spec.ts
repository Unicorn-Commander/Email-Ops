import { createHash } from 'crypto';
import {
  AgentInboxKind,
  AgentInboxState,
  EmailMode,
  EmailMessageStatus,
  Prisma,
} from '@prisma/client';
import { MailboxOwnerKind } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { AgentInboxController } from './agent-inbox.controller';

/**
 * Agent-inbox approve: the send-once contract of the human-in-the-loop SEND.
 *
 * The approve flow lives in EmailService.approveAgentInboxItem (phase 1 reads
 * the staged draft inside a withWorkspace tx, phase 2 hands the draft to the
 * mail engine via callEngine, phase 3 stamps the message SENT and flips the
 * item to APPROVED). Both the REST front door (AgentInboxController.approve)
 * and the MCP tool delegate to it, so this spec pins the service itself:
 *
 *   (1) approving a pending draft queues delivery exactly once and marks the
 *       item approved + the message sent;
 *   (2) approving the same item again (double click / retry) is a no-op that
 *       returns the current approved/sent state and never re-sends;
 *   (3) two concurrent approves of the same item send once: the code has no
 *       guard, so both calls phase 1 off the PENDING row and both phase 2.
 *       This test documents that behavior (finding in REPORT.md) by holding
 *       the engine behind a barrier so both approves enter the send lane;
 *   (4) rejecting an approved item is refused (non-pending no-op) and the
 *       message stays SENT: a reject can never unsend;
 *   (5) a caller from another workspace cannot approve the item: the
 *       workspaceId fence makes it resolve to null (-> 404 at the controller)
 *       and no send leaves.
 *
 * Mocks are the same seams the sibling specs use: the PrismaService (a
 * simulated withWorkspace over in-memory rows, the DB layer) and callEngine
 * (the transport seam the engine/provider sits behind). The approve service
 * under test is real: every other service is unused for this item's paths.
 * Fictional people and hosts (example.com) only; no network, no live engine.
 */

const WS_A = '0190a000-7e57-7000-8000-00000000a101';
const WS_B = '0190a000-7e57-7000-8000-00000000a102';
const UID_A = 'kc-sub-reviewer-a';
const UID_B = 'kc-sub-reviewer-b';

const DRAFT = 'Hello Ada,\r\nYour Tuesday appointment is confirmed.\n';
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

function makeRow(
  itemId: string,
  workspaceId: string,
  opts: { state?: AgentInboxState; messageStatus?: EmailMessageStatus } = {},
) {
  return {
    id: itemId,
    workspaceId,
    messageId: `message-${itemId}`,
    kind: AgentInboxKind.EMAIL,
    approvalTier: 'MAILBOX_OWNER',
    approvalReason: null,
    state: opts.state ?? AgentInboxState.PENDING,
    draftedBy: 'fictional-agent',
    summary: 'Appointment confirmation',
    payload: null,
    bodySha256: hash(DRAFT),
    sentBodySha256: null,
    editedBeforeSend: null,
    factualCorrection: null,
    reviewedByUcUid: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date('2026-11-01T12:00:00.000Z'),
    message: {
      id: `message-${itemId}`,
      workspaceId,
      mailboxAccountId: null,
      kitId: null,
      sendAt: null,
      threadId: null,
      status: opts.messageStatus ?? EmailMessageStatus.PENDING_APPROVAL,
      mode: EmailMode.DRAFT,
      direction: 'SENT',
      externalSource: null,
      externalRef: null,
      fromAddress: 'reviewer-a@example.com',
      toAddress: 'ada@example.com',
      toAddresses: ['ada@example.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Appointment confirmation',
      body: DRAFT,
      preview: null,
      bodyHtml: null,
      attachments: null,
      inReplyToThreadId: null,
      providerMessageId: null,
      sentAt: null,
      createdAt: new Date('2026-11-01T12:00:00.000Z'),
    },
  };
}

function harness(rows: ReturnType<typeof makeRow>[]) {
  // Simulated DB: the withWorkspace tx resolves against the in-memory rows.
  // findFirst honors the workspaceId predicate (the tenant fence), so a row in
  // another workspace is invisible here exactly as it is under RLS.
  const tx = {
    membership: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mailboxAccount: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    agentSendKit: { findMany: jest.fn().mockResolvedValue([]) },
    emailMessage: {
      update: jest
        .fn()
        .mockImplementation(
          ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.find((r) => r.message.id === where.id);
            if (!row) return Promise.resolve(null);
            Object.assign(row.message, data);
            return Promise.resolve(row.message);
          },
        ),
    },
    agentInboxItem: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { id?: string; workspaceId?: string } }) =>
          Promise.resolve(
            rows.find(
              (r) =>
                (!where.id || r.id === where.id) &&
                (!where.workspaceId || r.workspaceId === where.workspaceId),
            ) ?? null,
          ),
        ),
      update: jest
        .fn()
        .mockImplementation(
          ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = rows.find((r) => r.id === where.id);
            if (!row) return Promise.resolve(null);
            Object.assign(row, data);
            return Promise.resolve(row);
          },
        ),
    },
    agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) =>
      Promise.resolve().then(() => fn(tx)),
    ),
  } as unknown as ConstructorParameters<typeof EmailService>[0];
  const service = new EmailService(prisma, {} as never, {} as never, {} as never);
  const engine = jest.fn(async (_mailbox: unknown, _req: unknown) => ({
    accepted: true,
    providerMessageId: 'fictional-provider-message',
    threadId: 'fictional-thread',
    lane: 'fictional',
    reason: null,
  }));
  (service as unknown as { callEngine: unknown }).callEngine = engine;
  return { rows, tx, service, engine, prisma };
}

describe('agent-inbox approve: sends exactly once (service-level)', () => {
  it('approving a pending draft queues delivery exactly once and marks it approved + sent', async () => {
    const { rows, tx, service, engine } = harness([makeRow('item-1', WS_A)]);

    const out = await service.approveAgentInboxItem(WS_A, UID_A, 'item-1', 'lgtm', false);

    expect(engine).toHaveBeenCalledTimes(1);
    expect(engine).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        fromAddress: 'reviewer-a@example.com',
        toAddress: 'ada@example.com',
        subject: 'Appointment confirmation',
        body: DRAFT,
      }),
    );
    expect(rows[0]).toMatchObject({
      state: AgentInboxState.APPROVED,
      reviewedByUcUid: UID_A,
      reviewNote: 'lgtm',
    });
    expect(rows[0].message).toMatchObject({
      status: EmailMessageStatus.SENT,
      providerMessageId: 'fictional-provider-message',
    });
    expect(out).toMatchObject({
      inbox: expect.objectContaining({ state: 'approved', review_note: 'lgtm' }),
      message: expect.objectContaining({ status: 'sent' }),
    });
    expect(tx.agentInboxItem.update).toHaveBeenCalledTimes(1);
    expect(tx.agentActionEvent.create).toHaveBeenCalledTimes(1);
  });

  it('approving the same approved item again is a no-op: no second send, current state returned', async () => {
    const { rows, service, engine } = harness([makeRow('item-1', WS_A)]);

    const first = await service.approveAgentInboxItem(WS_A, UID_A, 'item-1', 'lgtm', false);
    expect(engine).toHaveBeenCalledTimes(1);

    const second = await service.approveAgentInboxItem(
      WS_A,
      UID_A,
      'item-1',
      'double click',
      false,
    );
    expect(engine).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).toMatchObject({
      inbox: expect.objectContaining({ state: 'approved', review_note: 'lgtm' }),
      message: expect.objectContaining({ status: 'sent' }),
    });
  });

  it('two concurrent approves both enter the send lane (no guard: documented finding)', async () => {
    const { rows, service, engine } = harness([makeRow('item-1', WS_A)]);
    const entered = jest.fn();
    const settled = jest.fn();
    // Barrier: both approves must be parked inside the engine (phase 2) before
    // either one may finish and run phase 3.
    const parked = new Promise<void>((resolve) => {
      let done = 0;
      entered.mockImplementation(() => {
        if (++done === 2) resolve();
      });
      settled.mockImplementation(() => {
        if (++done === 4) resolve();
      });
    });
    engine.mockImplementation(async () => {
      entered();
      await parked;
      settled();
      return {
        accepted: true,
        providerMessageId: 'fictional-provider-message',
        threadId: 'fictional-thread',
        lane: 'fictional',
        reason: null,
      };
    });

    const results = await Promise.all([
      service.approveAgentInboxItem(WS_A, UID_A, 'item-1'),
      service.approveAgentInboxItem(WS_A, UID_A, 'item-1'),
    ]);

    // Both approves phase 1 off the PENDING row before either phase 3 flips the
    // state, so both phase 2. The code has no atomic claim; the outcome is
    // engine-dependent (both accepted here => two deliveries). Finding logged in
    // REPORT.md with the file:line of the phase 1 read.
    expect(entered).toHaveBeenCalledTimes(2);
    expect(engine).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(rows[0]).toMatchObject({ state: AgentInboxState.APPROVED });
  }, 15000);

  it('rejecting an approved item does not unsend: refused as a no-op, message stays sent', async () => {
    const { rows, service, engine } = harness([makeRow('item-1', WS_A)]);

    await service.approveAgentInboxItem(WS_A, UID_A, 'item-1', 'lgtm', false);
    expect(engine).toHaveBeenCalledTimes(1);
    expect(rows[0].message).toMatchObject({ status: EmailMessageStatus.SENT });

    const out = await service.rejectAgentInboxItem(WS_A, UID_A, 'item-1', 'second thoughts');

    expect(engine).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ state: AgentInboxState.APPROVED, reviewNote: 'lgtm' });
    expect(rows[0].message).toMatchObject({
      status: EmailMessageStatus.SENT,
      providerMessageId: 'fictional-provider-message',
    });
    expect(out).toMatchObject({
      inbox: expect.objectContaining({ state: 'approved', review_note: 'lgtm' }),
      message: expect.objectContaining({ status: 'sent' }),
    });
  });

  it('a caller from another workspace cannot approve the item: no send, no state change', async () => {
    const { rows, service, engine } = harness([makeRow('item-1', WS_A)]);

    const out = await service.approveAgentInboxItem(WS_B, UID_B, 'item-1');

    expect(out).toBeNull();
    expect(engine).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      state: AgentInboxState.PENDING,
      reviewedByUcUid: null,
    });
    expect(rows[0].message).toMatchObject({ status: EmailMessageStatus.PENDING_APPROVAL });

    const rejectOut = await service.rejectAgentInboxItem(WS_B, UID_B, 'item-1');
    expect(rejectOut).toBeNull();
    expect(rows[0]).toMatchObject({ state: AgentInboxState.PENDING });
  });
});

describe('agent-inbox approve: the REST front door (controller over the real service)', () => {
  const savedEnv = process.env.UC_ENTITLEMENT_MODE;
  beforeAll(() => {
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
  });
  afterAll(() => {
    process.env.UC_ENTITLEMENT_MODE = savedEnv;
  });

  const userA = { __ucUid: UID_A, __entitlements: ['email-ops'], __workspaceClaim: WS_A } as never;
  const userB = { __ucUid: UID_B, __entitlements: ['email-ops'], __workspaceClaim: WS_B } as never;

  function controllerFor(rows: ReturnType<typeof makeRow>[]) {
    const { service, engine } = harness(rows);
    const controller = new AgentInboxController(service, {
      assertCanReviewInbox: jest.fn().mockResolvedValue(WS_A),
    } as never);
    return { controller, engine };
  }

  it('approve: the controller 200s with the approved item and the message queued to the send lane once', async () => {
    const rows = [makeRow('item-1', WS_A)];
    const { controller, engine } = controllerFor(rows);

    const out = await controller.approve(WS_A, userA, 'item-1', { note: 'lgtm' });

    expect(engine).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ state: AgentInboxState.APPROVED });
    expect(rows[0].message).toMatchObject({ status: EmailMessageStatus.SENT });
    expect(out).toMatchObject({
      inbox: expect.objectContaining({ state: 'approved' }),
      message: expect.objectContaining({ status: 'sent' }),
    });
  });

  it('approve twice: the second call returns the current approved state, the engine is called once in total', async () => {
    const rows = [makeRow('item-1', WS_A)];
    const { controller, engine } = controllerFor(rows);

    const first = await controller.approve(WS_A, userA, 'item-1', {});
    const second = await controller.approve(WS_A, userA, 'item-1', {});

    expect(engine).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second).toMatchObject({ inbox: expect.objectContaining({ state: 'approved' }) });
  });

  it('approve from another workspace: 404 before any send, item untouched', async () => {
    const rows = [makeRow('item-1', WS_A)];
    const { controller, engine } = controllerFor(rows);

    await expect(controller.approve(WS_B, userB, 'item-1', {})).rejects.toMatchObject({
      status: 404,
    });

    expect(engine).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ state: AgentInboxState.PENDING });
    expect(rows[0].message).toMatchObject({ status: EmailMessageStatus.PENDING_APPROVAL });
  });
});
