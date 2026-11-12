import { AgentInboxKind, AgentInboxState, EmailMessageStatus } from '@prisma/client';
import {
  RECIPIENT_SUPPRESSED,
  RECIPIENT_SUPPRESSED_MESSAGE,
  SuppressionService,
} from '../unsubscribe/suppression.service';
import { EmailService } from './email.service';

/**
 * Suppressed recipients never reach the transport (task 35620737).
 *
 * These specs run the REAL code for the suppression gate:
 *
 *   - SuppressionService.assertRecipientsNotSuppressed /
 *     findSuppressedInTx are the REAL methods, constructed against a
 *     stateful fake DB layer (the same `prisma.withWorkspace(tx)` seam
 *     the existing email specs mock), so the workspaceId-scoped Prisma
 *     predicate (suppression.service.ts:326-345) runs unmocked.
 *   - The outbound transport (StalwartPort.send) and the mail provider
 *     are mocked, exactly like email.compose-idempotency.spec.ts.
 *
 * Pinned behaviors (with the code that proves each):
 *   1. compose mode=send to a suppressed address: the gate throws
 *      ForbiddenException(RECIPIENT_SUPPRESSED) at email.service.ts:2081
 *      before any SoR row is recorded and before the transport is
 *      touched; the caller sees the stable reason + message.
 *   2. One suppressed + one allowed recipient on the same message: the
 *      code REFUSES THE WHOLE MESSAGE. assertRecipientsNotSuppressed
 *      throws as soon as findSuppressedInTx (suppression.service.ts:326)
 *      finds ANY match in the combined to/cc/bcc set (the full
 *      recipient list is passed at email.service.ts:2081-2085; there is
 *      no per-recipient drop path).
 *   3. Suppression is PER WORKSPACE: the gate query scopes on
 *      workspaceId (suppression.service.ts:331-334), so a suppression
 *      row in workspace A does not block a compose in workspace B for
 *      the same address.
 *   4. Approving an agent-inbox draft whose recipient was suppressed
 *      AFTER staging: approveAgentInboxItem re-checks the live
 *      suppression at approval time (email.service.ts:4006-4037),
 *      records the refusal on the inbox row (approvalReason =
 *      RECIPIENT_SUPPRESSED, summary suffix, payload.policy reason),
 *      and throws without ever calling the transport.
 *
 * Fictional data only (example.test). No network, no database.
 */

const WS_A = '00000000-0000-4000-8000-00000000000a';
const WS_B = '00000000-0000-4000-8000-00000000000b';
const UC_UID = 'uc-uid-fictional-reviewer';

const SUPPRESSED_READER = 'reader@example.test';
const ALLOWED_READER = 'allowed@example.test';

type Row = Record<string, unknown>;

interface FakeMailbox extends Row {
  id: string;
  workspaceId: string;
  emailAddress: string;
}

function mailbox(workspaceId: string, id: string, emailAddress: string): FakeMailbox {
  return {
    id,
    workspaceId,
    emailAddress,
    displayName: 'Fictional Desk',
    isDefault: true,
    active: true,
    // SHARED so the per-user mailbox fence (mayActThroughMailbox) passes for
    // any caller without a user lookup.
    ownerKind: 'SHARED',
    ownerKey: null,
    postmarkLane: true,
    provider: 'stalwart',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** A stateful in-memory stand-in for the DB models the gate touches. */
function makeFakeDb(mailboxes: FakeMailbox[], suppressions: Row[]) {
  const emailMessages: Row[] = [];
  const agentInboxItems: Row[] = [];
  let msgSeq = 0;
  let itemSeq = 0;

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (want && typeof want === 'object' && 'in' in (want as Record<string, unknown>)) {
        return ((want as { in: unknown[] }).in as unknown[]).includes(row[key]);
      }
      return row[key] === want;
    });

  // The one model the suppression gate queries. Runs the REAL
  // SuppressionService.findSuppressedInTx predicate (workspaceId +
  // email `in` the normalized recipient set) against the seeded rows.
  const suppressedRecipient = {
    findFirst: jest.fn(async (args: any): Promise<Row | null> => {
      const where: Row = args?.where ?? {};
      const emailFilter: Row = (where.email as Row) ?? {};
      const emails: string[] =
        emailFilter && 'in' in emailFilter ? ((emailFilter.in as unknown[]) as string[]) : [];
      const inWorkspace = suppressions.filter((row) => row.workspaceId === where.workspaceId);
      const hit = inWorkspace.find((row) => emails.includes(String(row.email)));
      if (!hit) return null;
      return { ...hit };
    }),
    upsert: jest.fn().mockImplementation(async (args: any) => {
      const where: Row = args?.where ?? {};
      const create: Row = args?.create ?? {};
      const key: Row = (where.workspaceId_email as Row) ?? {};
      const existing = suppressions.find(
        (row) => row.workspaceId === key.workspaceId && row.email === key.email,
      );
      if (existing) {
        Object.assign(existing, create);
        return { ...existing };
      }
      const row: Row = {
        id: `supp-${suppressions.length + 1}`,
        note: null,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        ...create,
      };
      suppressions.push(row);
      return row;
    }),
  };

  const tx: any = {
    // resolveMailboxScope: no membership => ungoverned legacy scope (all
    // mailboxes visible), so the send identity resolves to the default.
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: { findUnique: jest.fn().mockResolvedValue(null) },
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ agentsPaused: false, approvalKeywords: null }),
    },
    agent: { findFirst: jest.fn().mockResolvedValue(null) },
    mailboxAccount: {
      findMany: jest.fn(async ({ where }: { where?: Row }) =>
        mailboxes.filter((m) => matches(m, where ?? {})),
      ),
      findFirst: jest.fn(
        async ({ where }: { where?: Row }) =>
          mailboxes.find((m) => matches(m, where ?? {})) ?? null,
      ),
    },
    emailMessage: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => {
        const key = where.workspaceId_externalSource_externalRef as Row | undefined;
        if (key) {
          return (
            emailMessages.find(
              (r) =>
                r.workspaceId === key.workspaceId &&
                r.externalSource === key.externalSource &&
                r.externalRef === key.externalRef,
            ) ?? null
          );
        }
        if (where.id) return emailMessages.find((r) => r.id === where.id) ?? null;
        return null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row: Row = {
          id: `msg-${++msgSeq}`,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          threadId: null,
          providerMessageId: null,
          sentAt: null,
          ...data,
        };
        emailMessages.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = emailMessages.find((r) => r.id === where.id);
        if (!row) throw new Error('emailMessage.update: no such row');
        Object.assign(row, data);
        return row;
      }),
    },
    agentInboxItem: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const msg = emailMessages.find((m) => m.id === data.messageId);
        const row: Row = {
          id: `item-${++itemSeq}`,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          reviewedByUcUid: null,
          approvalReason: null,
          kind: AgentInboxKind.EMAIL,
          ...data,
          // The code reads item.message.* (include: { message: true }) and
          // never item.messageId, so resolve the relation into the row.
          message: msg ? { ...msg } : null,
        };
        agentInboxItems.push(row);
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where }: { where: Row }) => {
        const row = agentInboxItems.find((r) => matches(r, where ?? {}));
        return row ? { ...row, message: { ...(row.message ?? {}) } } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = agentInboxItems.find((r) => r.id === where.id);
        if (!row) throw new Error('agentInboxItem.update: no such row');
        Object.assign(row, data);
        return { ...row, message: { ...(row.message ?? {}) } };
      }),
    },
    mailContact: { upsert: jest.fn().mockResolvedValue({}) },
    agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
    suppressedRecipient,
  };

  return { tx, emailMessages, agentInboxItems };
}

/** The outbound transport mock: records every engine send. */
function makeTransport() {
  const sendCalls: Array<{ req: Row; transactional: boolean }> = [];
  const stalwart: any = {
    isConfigured: () => true,
    send: jest.fn(async (_from: string, req: Row, transactional: boolean) => {
      sendCalls.push({ req, transactional });
      return {
        accepted: true,
        providerMessageId: `prov-${sendCalls.length}`,
        threadId: req.inReplyToThreadId ?? `thread-${sendCalls.length}`,
        lane: transactional ? 'postmark' : 'stalwart',
      };
    }),
  };
  return { stalwart, sendCalls };
}

function setup(suppressions: Row[] = []) {
  const mailboxes = [
    mailbox(WS_A, 'mb-a', 'desk-a@example.test'),
    mailbox(WS_B, 'mb-b', 'desk-b@example.test'),
  ];
  const { tx, emailMessages, agentInboxItems } = makeFakeDb(mailboxes, suppressions);
  const { stalwart, sendCalls } = makeTransport();
  const prisma: any = {
    withWorkspace: jest.fn(async (_ws: string, _uid: string | null, fn: (t: unknown) => unknown) =>
      fn(tx),
    ),
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  // mailProvider.handles => false so the sovereign (Stalwart) send lane is used.
  const mailProvider: any = { handles: () => false };
  // The REAL SuppressionService against the fake DB (no mocks on its methods).
  const suppressionsService = new SuppressionService(prisma as never, {} as never, undefined);
  const service = new EmailService(
    prisma,
    stalwart,
    {} as never,
    mailProvider as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    suppressionsService,
  );
  return { service, suppressions, emailMessages, agentInboxItems, sendCalls, stalwart };
}

/** Seed a suppression row through the REAL service (the manual upsert path). */
function seedSuppression(
  service: EmailService,
  workspaceId: string,
  email: string,
): Promise<unknown> {
  const suppressionsService = (service as any)['suppressions'] as SuppressionService;
  return suppressionsService.suppressManually(workspaceId, UC_UID, email, 'Fictional note');
}

describe('suppressed recipients never sent', () => {
  it('1: compose mode=send to a suppressed address records no row and never calls the transport', async () => {
    const { service, suppressions, emailMessages, sendCalls, stalwart } = setup();
    await seedSuppression(service, WS_A, SUPPRESSED_READER);
    expect(suppressions).toHaveLength(1);

    await expect(
      service.composeEmail(WS_A, UC_UID, {
        contactId: null,
        toAddress: SUPPRESSED_READER,
        subject: 'Fictional subject',
        body: 'Fictional body',
        mode: 'send',
        externalSource: 'email-ops-client',
        externalRef: 'suppression-compose-send-555',
      }),
    ).rejects.toMatchObject({
      response: {
        error: 'Forbidden',
        message: RECIPIENT_SUPPRESSED,
        statusCode: 403,
      },
    });
    // The gate (email.service.ts:2081) runs before the SoR write and the
    // transport hand-off: nothing was recorded, nothing was sent.
    expect(emailMessages).toHaveLength(0);
    expect(stalwart.send).not.toHaveBeenCalled();
    expect(sendCalls).toHaveLength(0);
  });

  it('2: one suppressed + one allowed recipient refuses the WHOLE message (no drop path)', async () => {
    const { service, emailMessages, sendCalls, stalwart } = setup();
    await seedSuppression(service, WS_A, SUPPRESSED_READER);

    await expect(
      service.composeEmail(WS_A, UC_UID, {
        contactId: null,
        toAddress: ALLOWED_READER,
        toAddresses: [ALLOWED_READER, SUPPRESSED_READER],
        subject: 'Fictional subject',
        body: 'Fictional body',
        mode: 'send',
        externalSource: 'email-ops-client',
        externalRef: 'suppression-mixed-555',
      }),
    ).rejects.toMatchObject({
      response: { error: 'Forbidden', message: RECIPIENT_SUPPRESSED, statusCode: 403 },
    });
    // The actual rule: the gate checks the combined to/cc/bcc set and throws
    // on the FIRST suppressed match (email.service.ts:2081-2085 passes the
    // full list; suppression.service.ts:342-344 throws on any hit). The
    // allowed recipient does NOT get a partial send and no row is recorded.
    expect(emailMessages).toHaveLength(0);
    expect(stalwart.send).not.toHaveBeenCalled();
    expect(sendCalls).toHaveLength(0);
  });

  it('3: suppression is per workspace: a row in workspace A does not block workspace B', async () => {
    const { service, suppressions, sendCalls, stalwart } = setup();
    await seedSuppression(service, WS_A, SUPPRESSED_READER);

    // Same address, other workspace: the gate predicate scopes on
    // workspaceId (suppression.service.ts:331-334) and finds no row, so the
    // send proceeds through the (mocked) transport.
    const result = await service.composeEmail(WS_B, UC_UID, {
      contactId: null,
      toAddress: SUPPRESSED_READER,
      subject: 'Fictional subject',
      body: 'Fictional body',
      mode: 'send',
      externalSource: 'email-ops-client',
      externalRef: 'suppression-cross-ws-555',
    });
    expect(result.status).toBe('sent');
    expect(stalwart.send).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);

    // And the SAME address in workspace A is still refused: the suppression
    // did not leak across workspaces in either direction.
    await expect(
      service.composeEmail(WS_A, UC_UID, {
        contactId: null,
        toAddress: SUPPRESSED_READER,
        subject: 'Fictional subject',
        body: 'Fictional body',
        mode: 'send',
        externalSource: 'email-ops-client',
        externalRef: 'suppression-cross-ws-555-a',
      }),
    ).rejects.toMatchObject({
      response: { error: 'Forbidden', message: RECIPIENT_SUPPRESSED, statusCode: 403 },
    });
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ workspaceId: WS_A, email: SUPPRESSED_READER });
    expect(stalwart.send).toHaveBeenCalledTimes(1);
  });

  it('4: approving a draft whose recipient was suppressed AFTER staging does not send', async () => {
    const { service, agentInboxItems, emailMessages, sendCalls, stalwart } = setup();
    // Stage the draft while the recipient is still allowed.
    const staged = await service.composeEmail(WS_A, UC_UID, {
      contactId: null,
      toAddress: SUPPRESSED_READER,
      subject: 'Fictional subject',
      body: 'Fictional body',
      mode: 'draft',
      externalSource: 'email-ops-client',
      externalRef: 'suppression-stage-555',
    });
    expect(staged.status).toBe('pending_approval');
    expect(agentInboxItems).toHaveLength(1);
    const item = agentInboxItems[0] as unknown as Row;
    const itemId = String(item.id);
    expect(item.state).toBe(AgentInboxState.PENDING);

    // The recipient is suppressed AFTER staging (e.g. an unsubscribe or a
    // hard bounce lands while the draft sits in the queue).
    await seedSuppression(service, WS_A, SUPPRESSED_READER);

    // The approval re-checks the live suppression (email.service.ts:4006)
    // and refuses without touching the transport.
    await expect(
      service.approveAgentInboxItem(WS_A, UC_UID, itemId, 'fictional approval'),
    ).rejects.toMatchObject({
      response: {
        reason: RECIPIENT_SUPPRESSED,
        message: RECIPIENT_SUPPRESSED_MESSAGE,
      },
    });
    // The refusal is recorded on the inbox row exactly as the code does:
    // approvalReason + the stable summary suffix + a policy reason in the
    // payload (suppressionInboxData, email.service.ts:2636-2687). The fake
    // agentInboxItem.update returns a fresh copy, so read the stored row.
    const record = (agentInboxItems as unknown as Row[]).find((r) => String(r.id) === itemId);
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.approvalReason).toBe(RECIPIENT_SUPPRESSED);
    expect(String(record.summary)).toContain(RECIPIENT_SUPPRESSED);
    const payload = record.payload as { policy?: { reasons?: { code?: string }[] } } | null;
    expect(payload?.policy?.reasons?.map((r) => r.code)).toContain(RECIPIENT_SUPPRESSED);
    // The draft was never approved and nothing ever left the building.
    expect(item.state).toBe(AgentInboxState.PENDING);
    expect(item.reviewedByUcUid).toBeNull();
    expect(stalwart.send).not.toHaveBeenCalled();
    expect(sendCalls).toHaveLength(0);
    const message = emailMessages.find((r) => r.id === staged.id);
    expect(message?.status).toBe(EmailMessageStatus.PENDING_APPROVAL);
  });
});
