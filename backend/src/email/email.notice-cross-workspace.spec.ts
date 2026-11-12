import { NotFoundException } from '@nestjs/common';
import {
  AgentActionKind,
  AgentInboxKind,
  AgentInboxState,
  MailboxScope,
  MembershipStatus,
  WorkspaceRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartDraftRequest, StalwartMessageDetail, StalwartSendResult, StalwartVacationState } from '../stalwart/stalwart.types';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { MessageView } from '../email/email.types';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { DeviceConfigService } from '../mailbox-accounts/device-config.service';
import { EmailService } from './email.service';

/**
 * NOTICE-item cross-workspace fence (unit, hermetic).
 *
 * A mail-rule NOTICE item stores the SOURCE thread + mailbox in its payload
 * (payload.threadId / payload.mailboxId). The client surfaces those ids in the
 * GET /workspaces/:workspaceId/mail/:mailboxId/threads/:threadId route — a
 * workspace-A caller can therefore inject workspace B's ids and attempt to read
 * B's thread (full message BODIES) through A's session. These tests lock out
 * that path at the service seam, without a database:
 *
 *   - The mailbox is resolved with BOTH { id, workspaceId } (foreign id → null
 *     → indistinguishable empty read; the provider and engine are never
 *     consulted for another tenant's mailbox).
 *   - A same-workspace mailbox that is NOT in the caller's governed scope gets
 *     a 404 (human) / 403 (PAT-scoped) BEFORE any provider read.
 *   - The agent-inbox item lookup is fenced by workspaceId, so a foreign
 *     NOTICE id (even one whose payload names this workspace's mailbox) never
 *     resolves.
 *
 * Fictional data only (example.test). No network, no database.
 */

const WS_A = '00000000-0000-4000-8000-00000000000a';
const WS_B = '00000000-0000-4000-8000-00000000000b';
const UC_UID_A = 'uc-uid-workspace-a-caller';
const UC_UID_B = 'uc-uid-workspace-b-caller';

type Row = Record<string, unknown>;

interface FakeMailbox extends Row {
  id: string;
  workspaceId: string;
  emailAddress: string;
  ownerKind: 'HUMAN' | 'SHARED' | 'AGENT';
  ownerKey: string | null;
  provider: string;
  isDefault: boolean;
  active: boolean;
}

function mailbox(
  workspaceId: string,
  id: string,
  emailAddress: string,
  overrides: Partial<FakeMailbox> = {},
): FakeMailbox {
  return {
    id,
    workspaceId,
    emailAddress,
    displayName: 'Fictional Desk',
    // SHARED so the per-user mailbox fence (mayActThroughMailbox) passes for
    // any member of this workspace; cross-workspace denials below are then
    // purely the { id, workspaceId } + scope predicates under test.
    ownerKind: 'SHARED',
    ownerKey: null,
    kind: 'shared',
    provider: 'jmap',
    isDefault: true,
    active: true,
    postmarkLane: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

interface FakeItem extends Row {
  id: string;
  workspaceId: string;
  kind: string;
  state: string;
  payload: Record<string, unknown>;
}

interface NoticeFixture {
  items: FakeItem[];
  messages: Row[];
  tx: any;
}

function makeNoticeTx(opts: {
  mailboxes: FakeMailbox[];
  membership?: Row | null;
  items?: FakeItem[];
  messages?: Row[];
}) {
  const items: FakeItem[] = opts.items ?? [];
  const messages: Row[] = opts.messages ?? [];

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, want]) => {
      if (want && typeof want === 'object' && !Array.isArray(want) && 'in' in (want as Record<string, unknown>)) {
        return ((want as { in: unknown[] }).in as unknown[]).includes(row[key]);
      }
      if (want && typeof want === 'object' && !Array.isArray(want) && 'is' in (want as Record<string, unknown>)) {
        return matches(row, (want as { is: Row }).is);
      }
      if (want && typeof want === 'object' && !Array.isArray(want) && 'OR' in (want as Record<string, unknown>)) {
        return ((want as { OR: Row[] }).OR as Row[]).some((clause) => matches(row, clause));
      }
      return row[key] === want;
    });

  const tx: any = {
    // resolveMailboxScope inputs: membership decides the caller's scope.
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    membership: {
      findUnique: jest.fn().mockResolvedValue(opts.membership ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mailboxAccount: {
      findMany: jest.fn(async ({ where }: { where?: Row }) =>
        opts.mailboxes.filter((m) => matches(m, where ?? {})),
      ),
      findFirst: jest.fn(async ({ where = {} }: { where?: Row }) => {
        if (where.id && where.workspaceId) {
          return opts.mailboxes.find((m) => m.id === where.id && m.workspaceId === where.workspaceId) ?? null;
        }
        return opts.mailboxes.find((m) => matches(m, where)) ?? null;
      }),
    },
    emailMessage: {
      findMany: jest.fn(async ({ where }: { where?: Row }) => messages.filter((m) => matches(m, where ?? {}))),
    },
    agentInboxItem: {
      findFirst: jest.fn(async ({ where = {} }: { where?: Row }) => {
        if (where.id && where.workspaceId) {
          return items.find((i) => i.id === where.id && i.workspaceId === where.workspaceId) ?? null;
        }
        return items.find((i) => matches(i, where)) ?? null;
      }),
      update: jest.fn(),
    },
    agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
    mailContact: { upsert: jest.fn().mockResolvedValue({}) },
  };
  return { items, messages, tx };
}

/** The sentinel a regression would leak: workspace B's thread bodies. */
const B_SENTINEL_BODY = 'B-SENTINEL thread body — must never cross into workspace A';

function bDetail(): StalwartMessageDetail {
  return {
    id: 'b-m1',
    threadId: 'b-t1',
    from: { address: 'b-user@example.test', name: 'B User' },
    to: [],
    subject: 'B private',
    sentAt: '2026-01-02T00:00:00.000Z',
    preview: B_SENTINEL_BODY,
    direction: 'received',
    cc: [],
    bcc: [],
    htmlBody: `<p>${B_SENTINEL_BODY}</p>`,
    textBody: B_SENTINEL_BODY,
    messageIdHeader: '<b1@example.test>',
    references: null,
    isUnread: true,
    flagged: false,
    attachments: [],
  };
}

class FakeStalwart extends StalwartPort {
  constructor(private readonly calls: { mailbox: string; threadId: string }[] = []) {
    super();
  }
  async listFolderThreads() {
    return { threads: [] };
  }
  async getThreadDetail(mailbox: string, threadId: string) {
    this.calls.push({ mailbox, threadId });
    return [bDetail()];
  }
  async setThreadRead(): Promise<boolean> {
    return false;
  }
  async setThreadFlags(): Promise<boolean> {
    return false;
  }
  async moveThreadToFolder(): Promise<boolean> {
    return false;
  }
  async emptyFolder(): Promise<number | null> {
    return null;
  }
  async getMailboxCounts(): Promise<null> {
    return null;
  }
  async downloadBlob(): Promise<null> {
    return null;
  }
  async getMessageHeaders(): Promise<null> {
    return null;
  }
  async uploadBlob(): Promise<null> {
    return null;
  }
  async pollInbound(): Promise<null> {
    return null;
  }
  async moveThreadToMailbox(): Promise<boolean> {
    return false;
  }
  async listFolders(): Promise<never[]> {
    return [];
  }
  async createFolder(): Promise<null> {
    return null;
  }
  async renameFolder(): Promise<boolean> {
    return false;
  }
  async deleteFolder(): Promise<boolean> {
    return false;
  }
  isConfigured(): boolean {
    return true;
  }
  async listThreads() {
    return [];
  }
  async listMessages() {
    return [];
  }
  async saveDraft(_mailbox: string, _draft: StalwartDraftRequest): Promise<{ id: string } | null> {
    return null;
  }
  async updateDraft(
    _mailbox: string,
    _draftId: string,
    _draft: StalwartDraftRequest,
  ): Promise<{ id: string } | null> {
    return null;
  }
  async deleteDraft(): Promise<boolean> {
    return false;
  }
  async getVacation(): Promise<StalwartVacationState | null> {
    return null;
  }
  async setVacation(): Promise<boolean> {
    return false;
  }
  async send(): Promise<StalwartSendResult> {
    return { accepted: true, providerMessageId: 'x', threadId: 't1', lane: 'stalwart', reason: null };
  }
}

/** A provider that HANDLES jmap and returns the workspace-B sentinel. */
function sentinelProvider(calls: { mailboxId: string; threadId: string }[]): MailProviderPort {
  return {
    handles: () => true,
    listThreadMessages: (mb: { id: string }, threadId: string) => {
      calls.push({ mailboxId: mb.id, threadId });
      return Promise.resolve([
        {
          id: 'b-pm1',
          thread_id: 'b-t1',
          from: { address: 'b-user@example.test', name: 'B User' },
          to: [],
          subject: 'B private (provider)',
          sent_at: '2026-01-02T00:00:00.000Z',
          preview: B_SENTINEL_BODY,
          direction: 'inbound',
        } as MessageView,
      ]);
    },
  } as unknown as MailProviderPort;
}

function connectedAccounts(): ConnectedAccountsService {
  return {
    approveCleanupBatch: jest.fn(),
    undoBatch: jest.fn(),
  } as unknown as ConnectedAccountsService;
}

function buildService(tx: any, stalwart: FakeStalwart, provider: MailProviderPort): EmailService {
  const prisma = {
    withWorkspace: jest.fn(
      (_ws: string, _uid: string | null, fn: (t: unknown) => unknown) => Promise.resolve(fn(tx)),
    ),
  } as unknown as PrismaService;
  return new EmailService(prisma, stalwart, connectedAccounts(), provider);
}

const A_SHARED_MB = mailbox(WS_A, 'mb-a-shared', 'a-shared@example.test');
const A_HUMAN_MB = mailbox(WS_A, 'mb-a-human', 'a-user@example.test', {
  ownerKind: 'HUMAN',
  ownerKey: 'a-owner-kc',
  isDefault: false,
});
const B_SHARED_MB = mailbox(WS_B, 'mb-b-shared', 'b-shared@example.test');

/** The NOTICE payload mail-rules.service.ts stores on a workspace-B item. */
function bNoticePayload(): Record<string, unknown> {
  return {
    type: 'mail_rule_notice',
    ruleId: 'rule-b1',
    ruleName: 'B rule',
    mailboxId: B_SHARED_MB.id,
    mailboxAddress: B_SHARED_MB.emailAddress,
    threadId: 'b-t1',
    from: 'b-user@example.test',
    subject: 'B private',
    receivedAt: '2026-01-02T00:00:00.000Z',
  };
}

describe('NOTICE item payload ids cannot cross workspace boundaries (unit)', () => {
  const governed = (role: WorkspaceRole = WorkspaceRole.MEMBER): Row => ({
    role,
    status: MembershipStatus.ACTIVE,
    mailboxScope: MailboxScope.OWNED,
    userKey: UC_UID_A,
  });

  it('thread read: a workspace-A caller passing a workspace-B mailboxId from a NOTICE payload reads nothing', async () => {
    const { tx } = makeNoticeTx({
      mailboxes: [A_SHARED_MB, B_SHARED_MB],
      membership: governed(),
    });
    const calls: { mailboxId: string; threadId: string }[] = [];
    const stalwart = new FakeStalwart();
    const service = buildService(tx, stalwart, sentinelProvider(calls));

    // Exactly the payload the B tenant's NOTICE item carries.
    const page = await service.listThreadMessagesPage(WS_A, UC_UID_A, 'b-t1', B_SHARED_MB.id);

    expect(page.messages).toEqual([]);
    expect(page.status).toBe('ok');
    // The provider was never consulted for a foreign mailbox, and the engine
    // never fetched another tenant's thread.
    expect(calls).toEqual([]);
    expect(stalwart['calls']).toEqual([]);
  });

  it('thread read: a foreign mailbox id is indistinguishable from an unknown one (no SoR rows leak either)', async () => {
    // A SoR emailMessage row exists in WORKSPACE A with the SAME thread id — a
    // regression that dropped the workspace predicate on the SoR merge would
    // return it to the cross-workspace reader.
    const { tx } = makeNoticeTx({
      mailboxes: [A_SHARED_MB, B_SHARED_MB],
      membership: governed(),
      messages: [
        {
          id: 'a-sor-1',
          workspaceId: WS_A,
          threadId: 'b-t1',
          mailboxAccountId: A_SHARED_MB.id,
          fromAddress: 'a-sender@example.test',
          toAddress: 'a-rcpt@example.test',
          subject: 'A row with a colliding thread id',
          body: 'A-SENTINEL SoR body',
          preview: null,
          direction: 'sent',
          sentAt: new Date('2026-01-03T00:00:00.000Z'),
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        },
      ],
    });
    const calls: { mailboxId: string; threadId: string }[] = [];
    const stalwart = new FakeStalwart();
    const service = buildService(tx, stalwart, sentinelProvider(calls));

    const page = await service.listThreadMessagesPage(WS_A, UC_UID_A, 'b-t1', B_SHARED_MB.id);

    expect(page.messages).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('thread read: a same-workspace mailbox outside the caller OWNED scope is 404 before any provider read', async () => {
    // A-HUMAN is in workspace A but owned by ANOTHER member (ownerKey
    // a-owner-kc ≠ UC_UID_A); an OWNED-scoped caller may not act through it.
    // A governed denial is a NotFoundException — indistinguishable from a
    // missing mailbox — and the provider is never consulted.
    const { tx } = makeNoticeTx({
      mailboxes: [A_SHARED_MB, A_HUMAN_MB],
      membership: governed(WorkspaceRole.MEMBER),
    });
    const calls: { mailboxId: string; threadId: string }[] = [];
    const stalwart = new FakeStalwart();
    const service = buildService(tx, stalwart, sentinelProvider(calls));

    await expect(
      service.listThreadMessagesPage(WS_A, UC_UID_A, 'a-t1', A_HUMAN_MB.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toEqual([]);
    expect(stalwart['calls']).toEqual([]);
  });

  it('thread read: an ADMIN of workspace A still cannot read a workspace-B mailbox', async () => {
    // ADMIN/OWNER scope is workspace-wide — but only WITHIN this workspace.
    // The { id, workspaceId } predicate on the mailbox lookup is the cross-
    // tenant fence; scope cannot widen it.
    const { tx } = makeNoticeTx({
      mailboxes: [A_SHARED_MB, B_SHARED_MB],
      membership: governed(WorkspaceRole.ADMIN),
    });
    const calls: { mailboxId: string; threadId: string }[] = [];
    const stalwart = new FakeStalwart();
    const service = buildService(tx, stalwart, sentinelProvider(calls));

    const page = await service.listThreadMessagesPage(WS_A, UC_UID_A, 'b-t1', B_SHARED_MB.id);
    expect(page.messages).toEqual([]);
    expect(calls).toEqual([]);
    expect(stalwart['calls']).toEqual([]);
  });

  it('thread read: the legitimate owner in workspace B CAN read their own thread (fence is not over-broad)', async () => {
    const { tx } = makeNoticeTx({
      mailboxes: [A_SHARED_MB, B_SHARED_MB],
      membership: {
        role: WorkspaceRole.ADMIN,
        status: MembershipStatus.ACTIVE,
        mailboxScope: MailboxScope.ALL,
        userKey: UC_UID_B,
      },
    });
    const stalwart = new FakeStalwart();
    const providerCalls: { mailboxId: string; threadId: string }[] = [];
    const service = buildService(tx, stalwart, sentinelProvider(providerCalls));

    const page = await service.listThreadMessagesPage(WS_B, UC_UID_B, 'b-t1', B_SHARED_MB.id);
    expect(page.messages.map((m) => m.id)).toEqual(['b-pm1']);
    expect(providerCalls).toEqual([{ mailboxId: B_SHARED_MB.id, threadId: 'b-t1' }]);
  });
});

describe('NOTICE item detail/approval is workspace-fenced (unit)', () => {
  const noticeItem = (workspaceId: string, id: string): FakeItem => ({
    id,
    workspaceId,
    kind: AgentInboxKind.NOTICE,
    state: AgentInboxState.PENDING,
    messageId: null,
    smsMessageId: null,
    approvalTier: 'MAILBOX_OWNER',
    draftedBy: 'mail-rule:rule-b1',
    summary: 'B rule: b-user@example.test · B private',
    reviewedByUcUid: null,
    reviewedAt: null,
    reviewNote: null,
    bodySha256: null,
    sentBodySha256: null,
    editedBeforeSend: null,
    factualCorrection: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    payload: bNoticePayload(),
  });

  function setup(opts: { items: FakeItem[]; membership: Row | null }) {
    const { tx } = makeNoticeTx({
      mailboxes: [A_SHARED_MB, B_SHARED_MB],
      membership: opts.membership,
      items: opts.items,
    });
    const stalwart = new FakeStalwart();
    const providerCalls: { mailboxId: string; threadId: string }[] = [];
    const service = buildService(tx, stalwart, sentinelProvider(providerCalls));
    return { service, tx, providerCalls };
  }

  it('a workspace-A caller cannot read a workspace-B NOTICE item id (even though its payload names B ids)', async () => {
    const { service } = setup({
      items: [noticeItem(WS_B, 'item-b1'), noticeItem(WS_A, 'item-a1')],
      membership: {
        role: WorkspaceRole.ADMIN,
        status: MembershipStatus.ACTIVE,
        mailboxScope: MailboxScope.ALL,
        userKey: UC_UID_A,
      },
    });

    // The cross-workspace id resolves to null → the controller maps that to a
    // 404; the item's payload (threadId/mailboxId of tenant B) never surfaces.
    await expect(service.getAgentInboxItemDetail(WS_A, UC_UID_A, 'item-b1')).resolves.toBeNull();
  });

  it('a workspace-A caller can still read their OWN workspace NOTICE item', async () => {
    const { service } = setup({
      items: [noticeItem(WS_B, 'item-b1'), noticeItem(WS_A, 'item-a1')],
      membership: {
        role: WorkspaceRole.ADMIN,
        status: MembershipStatus.ACTIVE,
        mailboxScope: MailboxScope.ALL,
        userKey: UC_UID_A,
      },
    });

    const detail = await service.getAgentInboxItemDetail(WS_A, UC_UID_A, 'item-a1');
    expect(detail).toBeTruthy();
    expect(detail!.id).toBe('item-a1');
    expect(detail!.payload).toMatchObject({ type: 'mail_rule_notice' });
  });

  it('rejecting a foreign NOTICE item is a no-op (no state change, no cross-tenant write)', async () => {
    const bItem = noticeItem(WS_B, 'item-b1');
    const { service, tx } = setup({
      items: [bItem],
      membership: {
        role: WorkspaceRole.ADMIN,
        status: MembershipStatus.ACTIVE,
        mailboxScope: MailboxScope.ALL,
        userKey: UC_UID_A,
      },
    });

    await expect(service.rejectAgentInboxItem(WS_A, UC_UID_A, 'item-b1')).resolves.toBeNull();
    expect(bItem.state).toBe(AgentInboxState.PENDING);
    expect(tx.agentInboxItem.update).not.toHaveBeenCalled();
    expect(tx.agentActionEvent.create).not.toHaveBeenCalled();
  });
});

describe('MailboxAccountsService.getMailbox is workspace-fenced (unit)', () => {
  function setup(opts: { mailboxes: FakeMailbox[]; membership?: Row | null }) {
    const tx = {
      mailboxAccount: {
        findFirst: jest.fn(
          async ({ where }: { where?: Row }) =>
            opts.mailboxes.find((m) => m.id === where?.id && m.workspaceId === where?.workspaceId) ??
            null,
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      agentMailbox: { count: jest.fn().mockResolvedValue(0) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      membership: {
        findUnique: jest.fn().mockResolvedValue(opts.membership ?? null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new MailboxAccountsService(
      prisma,
      { isConfigured: () => false } as unknown as MailEngineAdminPort,
      {} as DeviceConfigService,
    );
    return { service, tx };
  }

  it('a workspace-A caller requesting a workspace-B mailboxId gets null (→ 404)', async () => {
    const { service } = setup({
      mailboxes: [A_SHARED_MB, B_SHARED_MB],
      membership: {
        role: WorkspaceRole.ADMIN,
        status: MembershipStatus.ACTIVE,
        mailboxScope: MailboxScope.ALL,
        userKey: UC_UID_A,
      },
    });

    await expect(service.getMailbox(WS_A, UC_UID_A, B_SHARED_MB.id)).resolves.toBeNull();
  });

  it('the same request in the right workspace resolves the mailbox', async () => {
    const { service } = setup({
      mailboxes: [A_SHARED_MB, B_SHARED_MB],
      membership: null,
    });

    const view = await service.getMailbox(WS_B, UC_UID_B, B_SHARED_MB.id);
    expect(view).toBeTruthy();
    expect(view!.id).toBe(B_SHARED_MB.id);
    expect(view!.email_address).toBe(B_SHARED_MB.emailAddress);
  });
});
