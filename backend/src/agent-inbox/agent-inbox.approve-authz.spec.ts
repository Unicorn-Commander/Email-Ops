import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import {
  AgentInboxApprovalTier,
  AgentInboxKind,
  AgentInboxState,
  EmailMessageStatus,
  EmailMode,
  WorkspaceRole,
} from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PatService } from '../auth/pat.service';
import { MembershipService } from '../common/workspace/membership.service';
import { EmailService } from '../email/email.service';
import { AgentInboxController } from './agent-inbox.controller';

/**
 * Agent-inbox approve/reject authorization matrix (hermetic, NO database).
 *
 * Locks the cases the sibling specs leave open:
 *
 *   (A) an ANONYMOUS caller gets 401 on every agent-inbox decision route
 *       (list, approve, reject, bulk-approve) before any handler or service
 *       code runs (real JwtAuthGuard + JwtStrategy over a mocked service);
 *   (B) a workspace-B caller cannot approve workspace-A items INSIDE A BULK
 *       approve that mixes A and B ids: A's id comes back per-item
 *       `not_found`, A's row is untouched (no claim, no schedule, no send),
 *       and only B's own item is scheduled (real EmailService over in-memory
 *       rows fenced by workspaceId, the same fence RLS enforces in prod);
 *   (C) approving an already-REJECTED item never sends: the service returns
 *       the current rejected state as a no-op and the REST front door
 *       surfaces it without touching the transport.
 *
 * The mail transport is the mocked callEngine seam; nothing here can send
 * real mail. Fictional workspaces, users and addresses (example.com) only.
 */

const WS_A = '0190a000-7e57-7000-8000-00000000b101';
const WS_B = '0190a000-7e57-7000-8000-00000000b102';
const UID_A = 'kc-sub-caller-a';
const UID_B = 'kc-sub-caller-b';

const DRAFT = 'Hello Grace,\r\nYour Friday review is scheduled.\n';

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
    approvalTier: AgentInboxApprovalTier.MAILBOX_OWNER,
    approvalReason: null,
    state: opts.state ?? AgentInboxState.PENDING,
    draftedBy: 'fictional-agent',
    summary: 'Fictional review reminder',
    payload: null as unknown,
    bodySha256: null,
    sentBodySha256: null,
    editedBeforeSend: null,
    factualCorrection: null,
    reviewedByUcUid: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date('2026-11-02T09:00:00.000Z'),
    message: {
      id: `message-${itemId}`,
      workspaceId,
      mailboxAccountId: null,
      kitId: null,
      sendAt: null as Date | null,
      threadId: null,
      status: opts.messageStatus ?? EmailMessageStatus.PENDING_APPROVAL,
      mode: EmailMode.DRAFT,
      direction: 'SENT',
      externalSource: null,
      externalRef: null,
      fromAddress: 'desk-a@example.com',
      toAddress: 'grace@example.com',
      toAddresses: ['grace@example.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Fictional review reminder',
      body: DRAFT,
      preview: null,
      bodyHtml: null,
      attachments: null,
      inReplyToThreadId: null,
      providerMessageId: null,
      sentAt: null,
      createdAt: new Date('2026-11-02T09:00:00.000Z'),
    },
  };
}

type Row = ReturnType<typeof makeRow>;

function harness(rows: Row[]) {
  // Simulated DB: every read/write honors the workspaceId predicate, so a row
  // of another workspace is invisible exactly as it is under RLS.
  const visible = (row: Row, where: Record<string, any> = {}) =>
    (where.id === undefined ||
      (typeof where.id === 'object' && Array.isArray(where.id.in)
        ? where.id.in.includes(row.id)
        : where.id === row.id)) &&
    (where.workspaceId === undefined || row.workspaceId === where.workspaceId) &&
    (where.state === undefined || row.state === where.state);
  const tx: any = {
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mailboxAccount: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    agentSendKit: { findMany: jest.fn().mockResolvedValue([]) },
    emailMessage: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const row = rows.find((r) => r.message.id === where.id);
        if (!row) return Promise.resolve(null);
        Object.assign(row.message, data);
        return Promise.resolve(row.message);
      }),
    },
    agentInboxItem: {
      findMany: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(rows.filter((r) => visible(r, where))),
      ),
      findFirst: jest.fn().mockImplementation(({ where }) => {
        const row = rows.find((r) => visible(r, where));
        return Promise.resolve(row ? { ...row, message: { ...row.message } } : null);
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }) => {
        const row = rows.find((r) => visible(r, where));
        if (!row) return Promise.resolve({ count: 0 });
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) return Promise.resolve(null);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
    agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) =>
      Promise.resolve().then(() => fn(tx)),
    ),
  } as unknown as ConstructorParameters<typeof EmailService>[0];
  const service = new EmailService(prisma, {} as never, {} as never, {} as never);
  const engine = jest.fn(async () => ({
    accepted: true,
    providerMessageId: 'fictional-provider-message',
    threadId: 'fictional-thread',
    lane: 'fictional',
    reason: null,
  }));
  (service as unknown as { callEngine: unknown }).callEngine = engine;
  return { rows, tx, service, engine };
}

describe('agent-inbox decision routes: anonymous callers are 401 (real guards)', () => {
  let app: INestApplication;
  let origin: string;
  const email = {
    listAgentInbox: jest.fn().mockResolvedValue([]),
    peekAgentInboxKind: jest.fn().mockResolvedValue(null),
    approveAgentInboxItem: jest.fn(),
    rejectAgentInboxItem: jest.fn(),
    bulkApproveAgentInboxItems: jest.fn(),
  };

  beforeAll(async () => {
    const config = new ConfigService({
      JWT_SECRET: 'anon-401-tests-only',
      EMAIL_OPS_TENANCY_ENABLED: 'true',
    });
    const fakePrisma = {} as never;
    const mod = await Test.createTestingModule({
      controllers: [AgentInboxController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        { provide: ConfigService, useValue: config },
        {
          provide: AuthService,
          useValue: new AuthService(new JwtService({ secret: 'anon-401-tests-only' }), fakePrisma),
        },
        {
          provide: MembershipService,
          useValue: {
            assertCanReviewInbox: jest.fn().mockResolvedValue(WS_A),
            resolveWithRole: jest.fn(),
          } as unknown as MembershipService,
        },
        { provide: PatService, useValue: new PatService(fakePrisma) },
        { provide: EmailService, useValue: email },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  async function anonymous(path: string, method: 'GET' | 'POST') {
    return fetch(`${origin}/workspaces/${WS_A}/agent-inbox${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
  }

  it('list, approve, reject and bulk-approve all answer 401 with no credential', async () => {
    expect((await anonymous('', 'GET')).status).toBe(401);
    expect((await anonymous('/item-1/approve', 'POST')).status).toBe(401);
    expect((await anonymous('/item-1/reject', 'POST')).status).toBe(401);
    expect((await anonymous('/bulk-approve', 'POST')).status).toBe(401);
    expect(email.listAgentInbox).not.toHaveBeenCalled();
    expect(email.approveAgentInboxItem).not.toHaveBeenCalled();
    expect(email.rejectAgentInboxItem).not.toHaveBeenCalled();
    expect(email.bulkApproveAgentInboxItems).not.toHaveBeenCalled();
  });

  it('a forged unsigned bearer token is also 401, never a handler call', async () => {
    const res = await fetch(`${origin}/workspaces/${WS_A}/agent-inbox/item-1/approve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-signed-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(email.approveAgentInboxItem).not.toHaveBeenCalled();
  });
});

describe('agent-inbox bulk approve: the workspace fence per item id (real service)', () => {
  it('a workspace-B caller in a mixed bulk approve gets not_found for A ids and never sends A mail', async () => {
    const { rows, tx, service, engine } = harness([
      makeRow('item-a1', WS_A),
      makeRow('item-b1', WS_B),
    ]);

    const out = await service.bulkApproveAgentInboxItems(
      WS_B,
      UID_B,
      ['item-a1', 'item-b1'],
      'fictional note',
      false,
      false,
      WorkspaceRole.MEMBER,
    );

    const byId = Object.fromEntries(out.items.map((item) => [item.item_id, item]));
    expect(byId['item-a1']).toMatchObject({ status: 'refused', reason: 'not_found' });
    expect(byId['item-b1']).toMatchObject({ status: 'scheduled' });
    expect(out.approved_count).toBe(1);
    expect(out.refused_count).toBe(1);

    // A's row is untouched: no claim, no reviewer stamp, no schedule, no send.
    expect(rows[0]).toMatchObject({
      state: AgentInboxState.PENDING,
      reviewedByUcUid: null,
      reviewNote: null,
    });
    expect(rows[0].message).toMatchObject({
      status: EmailMessageStatus.PENDING_APPROVAL,
      sendAt: null,
    });
    // Only B's message was scheduled; the transport was never entered.
    expect(tx.emailMessage.update).toHaveBeenCalledTimes(1);
    expect(tx.emailMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'message-item-b1' } }),
    );
    expect(engine).not.toHaveBeenCalled();
    // And the audit trail records only B's approval.
    expect(tx.agentActionEvent.create).toHaveBeenCalledTimes(1);
  });

  it('the mirror case holds: an A caller cannot schedule B ids either', async () => {
    const { rows, service, engine } = harness([
      makeRow('item-a1', WS_A),
      makeRow('item-b1', WS_B),
    ]);

    const out = await service.bulkApproveAgentInboxItems(WS_A, UID_A, ['item-b1', 'item-a1']);

    const byId = Object.fromEntries(out.items.map((item) => [item.item_id, item]));
    expect(byId['item-b1']).toMatchObject({ status: 'refused', reason: 'not_found' });
    expect(byId['item-a1']).toMatchObject({ status: 'scheduled' });
    expect(rows[1]).toMatchObject({ state: AgentInboxState.PENDING });
    expect(rows[1].message.sendAt).toBeNull();
    expect(engine).not.toHaveBeenCalled();
  });

  it('the REST bulk-approve front door passes foreign ids through as per-item not_found without touching A', async () => {
    const savedEnv = process.env.UC_ENTITLEMENT_MODE;
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
    try {
      const { rows, service, engine } = harness([
        makeRow('item-a1', WS_A),
        makeRow('item-b1', WS_B),
      ]);
      const controller = new AgentInboxController(service, {
        assertCanReviewInbox: jest.fn().mockResolvedValue(WS_B),
      } as never);
      const userB = {
        __ucUid: UID_B,
        __entitlements: ['email-ops'],
        __workspaceClaim: WS_B,
      } as never;

      const out = await controller.bulkApprove(
        WS_B,
        userB,
        { item_ids: ['item-a1', 'item-b1'] },
        WorkspaceRole.MEMBER,
      );

      const byId = Object.fromEntries(
        (out as { items: { item_id: string; status: string; reason?: string }[] }).items.map(
          (item) => [item.item_id, item],
        ),
      );
      expect(byId['item-a1']).toMatchObject({ status: 'refused', reason: 'not_found' });
      expect(byId['item-b1']).toMatchObject({ status: 'scheduled' });
      expect(rows[0]).toMatchObject({ state: AgentInboxState.PENDING });
      expect(rows[0].message.sendAt).toBeNull();
      expect(engine).not.toHaveBeenCalled();
    } finally {
      process.env.UC_ENTITLEMENT_MODE = savedEnv;
    }
  });
});

describe('agent-inbox approve: an already-rejected item never sends (no-op contract)', () => {
  it('service: approving a rejected item returns the current rejected state, transport untouched', async () => {
    const { rows, service, engine } = harness([
      makeRow('item-1', WS_A, {
        state: AgentInboxState.REJECTED,
        messageStatus: EmailMessageStatus.REJECTED,
      }),
    ]);

    const out = await service.approveAgentInboxItem(WS_A, UID_A, 'item-1', 'second thoughts');

    expect(engine).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      state: AgentInboxState.REJECTED,
      reviewedByUcUid: null,
    });
    expect(rows[0].message).toMatchObject({ status: EmailMessageStatus.REJECTED });
    expect(out).toMatchObject({
      inbox: expect.objectContaining({ state: 'rejected' }),
      message: expect.objectContaining({ status: 'rejected' }),
    });
  });

  it('REST front door: approving a rejected item 200s with the rejected state and no send', async () => {
    const savedEnv = process.env.UC_ENTITLEMENT_MODE;
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
    try {
      const { rows, service, engine } = harness([
        makeRow('item-1', WS_A, {
          state: AgentInboxState.REJECTED,
          messageStatus: EmailMessageStatus.REJECTED,
        }),
      ]);
      const controller = new AgentInboxController(service, {
        assertCanReviewInbox: jest.fn().mockResolvedValue(WS_A),
      } as never);
      const userA = {
        __ucUid: UID_A,
        __entitlements: ['email-ops'],
        __workspaceClaim: WS_A,
      } as never;

      const out = await controller.approve(WS_A, userA, 'item-1', { note: 'second thoughts' });

      expect(engine).not.toHaveBeenCalled();
      expect(rows[0].state).toBe(AgentInboxState.REJECTED);
      expect(out).toMatchObject({
        inbox: expect.objectContaining({ state: 'rejected' }),
        message: expect.objectContaining({ status: 'rejected' }),
      });
    } finally {
      process.env.UC_ENTITLEMENT_MODE = savedEnv;
    }
  });
});
