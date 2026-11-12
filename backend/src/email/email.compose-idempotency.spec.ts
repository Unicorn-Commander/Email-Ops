import { EmailService } from './email.service';

/**
 * compose_email idempotency on (workspace_id, external_source, external_ref).
 *
 * The contract (email.service.ts composeEmail + the MCP manifest): a repeat
 * compose with the same tuple returns the EXISTING message and queues NO second
 * send. These specs prove the four required behaviors against a STATEFUL fake
 * of the database layer (the same `prisma.withWorkspace(tx)` seam the existing
 * email specs mock) and a mocked outbound transport (the StalwartPort send).
 *
 * The idempotency check itself is NEVER mocked: the fake `emailMessage` store
 * genuinely persists rows and genuinely answers the compound-unique lookup, so
 * composeEmail's own `findUnique({ workspaceId_externalSource_externalRef })`
 * short-circuit runs for real. Only the DB layer and the send transport are
 * faked; everything else (autonomy gate, draft staging, send stamping) runs.
 *
 * Fictional data only (example.test). No network, no database.
 */

const WS_A = '00000000-0000-4000-8000-00000000000a';
const WS_B = '00000000-0000-4000-8000-00000000000b';
const UC_UID = 'uc-uid-fictional-caller';

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
    // SHARED so the per-user mailbox fence (mayActThroughMailbox) passes for any
    // caller without a user lookup; the idempotent-hit path re-checks it.
    ownerKind: 'SHARED',
    ownerKey: null,
    postmarkLane: true,
    provider: 'jmap',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** A stateful in-memory stand-in for the DB models composeEmail touches. */
function makeFakeDb(mailboxes: FakeMailbox[]) {
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

  const tx: any = {
    // resolveMailboxScope: no membership => ungoverned legacy scope (all mailboxes).
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
      // The idempotency lookup, run for real against the persisted rows.
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
        const row: Row = {
          id: `item-${++itemSeq}`,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
          ...data,
        };
        agentInboxItems.push(row);
        return row;
      }),
    },
    mailContact: { upsert: jest.fn().mockResolvedValue({}) },
    agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
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

function setup() {
  const mailboxes = [
    mailbox(WS_A, 'mb-a', 'desk-a@example.test'),
    mailbox(WS_B, 'mb-b', 'desk-b@example.test'),
  ];
  const { tx, emailMessages, agentInboxItems } = makeFakeDb(mailboxes);
  const { stalwart, sendCalls } = makeTransport();
  const prisma: any = {
    withWorkspace: jest.fn(async (_ws: string, _uid: string | null, fn: (t: unknown) => unknown) =>
      fn(tx),
    ),
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  // mailProvider.handles => false so the sovereign (Stalwart) send lane is used.
  const mailProvider: any = { handles: () => false };
  const service = new EmailService(prisma, stalwart, {} as never, mailProvider as never);
  return { service, emailMessages, agentInboxItems, sendCalls, stalwart };
}

describe('compose_email idempotency on (workspace, external_source, external_ref)', () => {
  it('mode=draft: a repeat of the same tuple creates ONE agent-inbox item and returns the same id', async () => {
    const { service, emailMessages, agentInboxItems, sendCalls } = setup();
    const input = {
      contactId: null,
      toAddress: 'jane@example.test',
      subject: 'Following up',
      body: 'Hi Jane, checking in.',
      mode: 'draft' as const,
      externalSource: 'customer-ops',
      externalRef: 'draft-ref-1',
    };

    const first = await service.composeEmail(WS_A, UC_UID, input);
    const second = await service.composeEmail(WS_A, UC_UID, input);

    expect(second.id).toBe(first.id);
    expect(second).toEqual(first);
    // Exactly one staged message + one agent-inbox item across both calls.
    expect(emailMessages).toHaveLength(1);
    expect(agentInboxItems).toHaveLength(1);
    expect(agentInboxItems[0]).toMatchObject({ workspaceId: WS_A, messageId: first.id });
    // A draft never leaves; the transport was never touched.
    expect(sendCalls).toHaveLength(0);
  });

  it('mode=send: a repeat of the same tuple queues delivery ONCE (transport called once)', async () => {
    const { service, emailMessages, sendCalls, stalwart } = setup();
    const input = {
      contactId: null,
      toAddress: 'jane@example.test',
      subject: 'Following up',
      body: 'Hi Jane, checking in.',
      mode: 'send' as const,
      externalSource: 'customer-ops',
      externalRef: 'send-ref-1',
    };

    const first = await service.composeEmail(WS_A, UC_UID, input);
    const second = await service.composeEmail(WS_A, UC_UID, input);

    expect(second.id).toBe(first.id);
    expect(first.status).toBe('sent');
    expect(second.status).toBe('sent');
    // The send transport ran exactly once across both composes.
    expect(stalwart.send).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);
    // One durable SoR row for the tuple.
    expect(emailMessages).toHaveLength(1);
  });

  it('the same ref in a DIFFERENT workspace is a separate message', async () => {
    const { service, emailMessages, agentInboxItems } = setup();
    const input = {
      contactId: null,
      toAddress: 'jane@example.test',
      subject: 'Following up',
      body: 'Hi Jane, checking in.',
      mode: 'draft' as const,
      externalSource: 'customer-ops',
      externalRef: 'shared-ref',
    };

    const inA = await service.composeEmail(WS_A, UC_UID, input);
    const inB = await service.composeEmail(WS_B, UC_UID, input);

    expect(inB.id).not.toBe(inA.id);
    expect(emailMessages).toHaveLength(2);
    expect(agentInboxItems).toHaveLength(2);
    const wsOf = (id: string) => emailMessages.find((r) => r.id === id)?.workspaceId;
    expect(wsOf(inA.id)).toBe(WS_A);
    expect(wsOf(inB.id)).toBe(WS_B);
  });

  it('a different ref in the SAME workspace is a separate message', async () => {
    const { service, emailMessages, agentInboxItems } = setup();
    const base = {
      contactId: null,
      toAddress: 'jane@example.test',
      subject: 'Following up',
      body: 'Hi Jane, checking in.',
      mode: 'draft' as const,
      externalSource: 'customer-ops',
    };

    const one = await service.composeEmail(WS_A, UC_UID, { ...base, externalRef: 'ref-x' });
    const two = await service.composeEmail(WS_A, UC_UID, { ...base, externalRef: 'ref-y' });

    expect(two.id).not.toBe(one.id);
    expect(emailMessages).toHaveLength(2);
    expect(agentInboxItems).toHaveLength(2);
  });
});
