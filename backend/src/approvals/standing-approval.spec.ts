import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { buildAgentSendKitDefinition } from '../email/agent-send-kit';
import { StandingApprovalsService } from './standing-approvals.service';
import {
  assertStandingExpiry,
  DAY_MS,
  recipientRules,
  standingBinding,
  standingRefusalReason,
  standingTemplate,
  standingTemplateSha256,
} from './standing-approval';

const NOW = new Date('2026-10-26T16:00:00Z');
const definition = standingTemplate({
  bodyTemplate: 'Hello {first_name},\nA preview for your team.',
  subjects: ['Preview invitation'],
});
const approval = (overrides: Record<string, unknown> = {}): any => ({
  ...definition,
  id: 'approval-1',
  workspaceId: 'workspace-1',
  campaignKey: 'Preview',
  mailboxId: 'mailbox-1',
  fromAddress: 'team@example.org',
  templateSha256: standingTemplateSha256(definition),
  recipientRules: { blockedDomains: ['blocked.example.com'], allowedDomains: [] },
  capPerDay: 2,
  expiresAt: new Date(NOW.getTime() + DAY_MS),
  approvedAt: NOW,
  revokedAt: null,
  ...overrides,
});
const message = (overrides: Record<string, unknown> = {}): any => ({
  id: 'message-1',
  workspaceId: 'workspace-1',
  mailboxAccountId: 'mailbox-1',
  fromAddress: 'team@example.org',
  toAddress: 'pilot@example.com',
  toAddresses: ['pilot@example.com'],
  ccAddresses: [],
  bccAddresses: [],
  subject: 'Preview invitation',
  body: 'Hello Mira,\nA preview for your team.',
  bodyHtml: null,
  attachments: [],
  sendAt: null,
  kitId: null,
  ...overrides,
});

describe('standing campaign matching', () => {
  it('matches new recipients without binding a batch hash', () => {
    expect(standingRefusalReason(approval(), message(), 0, NOW)).toBeNull();
    expect(
      standingRefusalReason(approval(), message({ toAddresses: ['second@example.net'] }), 1, NOW),
    ).toBeNull();
  });

  it.each([
    ['cap', {}, {}, 2],
    ['expiry', { expiresAt: NOW }, {}, 0],
    ['revocation', { revokedAt: NOW }, {}, 0],
    ['pending', { approvedAt: null }, {}, 0],
    ['template body', {}, { body: 'Different copy' }, 0],
    ['template hash', { templateSha256: '0'.repeat(64) }, {}, 0],
    ['sender address', {}, { fromAddress: 'other@example.org' }, 0],
    ['sender mailbox', {}, { mailboxAccountId: 'mailbox-2' }, 0],
    ['recipient rule', {}, { toAddresses: ['pilot@blocked.example.com'] }, 0],
    ['allow rule', { recipientRules: { allowedDomains: ['allowed.example.com'] } }, {}, 0],
    ['cc', {}, { ccAddresses: ['extra@example.com'] }, 0],
    ['bcc', {}, { bccAddresses: ['extra@example.com'] }, 0],
    ['multiple recipients', {}, { toAddresses: ['pilot@example.com', 'second@example.net'] }, 0],
    ['HTML', {}, { bodyHtml: '<p>Unreviewed copy</p>' }, 0],
    ['attachment', {}, { attachments: [{ name: 'extra.txt' }] }, 0],
    ['subject', {}, { subject: 'Unreviewed subject' }, 0],
    ['invalid address', {}, { toAddresses: ['bad-address'] }, 0],
  ])('refuses %s', (_label, row, mail, used) => {
    expect(standingRefusalReason(approval(row), message(mail), used as number, NOW)).not.toBeNull();
  });

  it('binds limits, sender and rules independently of the template hash', () => {
    for (const change of [
      { capPerDay: 3 },
      { mailboxId: 'mailbox-2' },
      { expiresAt: new Date(NOW.getTime() + 2 * DAY_MS) },
      { recipientRules: {} },
    ]) {
      expect(standingBinding(approval(change)).definitionSha256).not.toBe(
        standingBinding(approval()).definitionSha256,
      );
    }
  });

  it('enforces the 90-day maximum and exact recipient-domain rules', () => {
    expect(() => assertStandingExpiry(new Date(NOW.getTime() + 90 * DAY_MS), NOW)).not.toThrow();
    for (const date of [NOW, new Date(NOW.getTime() + 90 * DAY_MS + 1), new Date('invalid')]) {
      expect(() => assertStandingExpiry(date, NOW)).toThrow(BadRequestException);
    }
    expect(
      recipientRules({ blockedDomains: ['BLOCKED.EXAMPLE.COM', 'blocked.example.com'] }),
    ).toEqual({ blockedDomains: ['blocked.example.com'], allowedDomains: [] });
    expect(() => recipientRules({ typo: true })).toThrow(BadRequestException);
    expect(() => recipientRules({ blockedDomains: ['*.example.com'] })).toThrow(
      BadRequestException,
    );
  });
});

describe('standing cap reservations and existing kit fallback', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  function harness(row = approval(), mail = message(), used = 0, kit: any = null) {
    const item: any = {
      id: 'inbox-1',
      workspaceId: 'workspace-1',
      messageId: mail.id,
      kind: 'EMAIL',
      state: 'PENDING',
      approvalTier: 'MAILBOX_OWNER',
      draftedBy: 'demo-agent',
      payload: null,
      message: mail,
    };
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      standingApproval: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(row),
      },
      standingApprovalUse: {
        count: jest.fn().mockResolvedValue(used),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      agentInboxItem: {
        findFirst: jest.fn().mockResolvedValue(item),
        update: jest.fn().mockResolvedValue({ ...item, state: 'APPROVED' }),
      },
      agentSendKit: { findFirst: jest.fn().mockResolvedValue(kit) },
      mailboxAccount: {
        findMany: jest.fn().mockResolvedValue([{ id: 'mailbox-1' }]),
        findFirst: jest.fn().mockResolvedValue({
          id: 'mailbox-1',
          emailAddress: 'team@example.org',
          ownerKind: 'SHARED',
        }),
      },
      mailDomain: { findMany: jest.fn().mockResolvedValue([]) },
      trustedCorrespondent: { findMany: jest.fn().mockResolvedValue([]) },
      emailMessage: {
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue(mail),
      },
    };
    const prisma: any = { withWorkspace: jest.fn((_ws, _uid, fn) => fn(tx)) };
    const standing = new StandingApprovalsService(prisma, {} as any, {} as any);
    const service = new EmailService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      standing,
    );
    const engine = jest.spyOn(service as any, 'callEngine').mockResolvedValue({ accepted: true });
    jest
      .spyOn(service as any, 'stampSendResult')
      .mockResolvedValue({ ...mail, status: 'SENT', mode: 'DRAFT', createdAt: NOW });
    jest.spyOn(service as any, 'reconcileMirroredDraft').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'recordAction').mockResolvedValue(undefined);
    return { tx, service, standing, engine };
  }

  it('a matching send passes and records the standing approval before delivery', async () => {
    const h = harness();
    await h.service.approveAgentInboxItem(
      'workspace-1',
      'demo-agent',
      'inbox-1',
      null,
      false,
      true,
    );
    expect(h.engine).toHaveBeenCalledTimes(1);
    expect(h.tx.agentSendKit.findFirst).not.toHaveBeenCalled();
    expect(h.tx.emailMessage.update).toHaveBeenCalledWith({
      where: { id: 'message-1', workspaceId: 'workspace-1' },
      data: { standingApprovalId: 'approval-1' },
    });
    expect(h.tx.standingApprovalUse.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: 'workspace-1', approvalId: 'approval-1' }),
      }),
    );
  });

  it.each([
    ['cap', {}, {}, 2],
    ['expiry', { expiresAt: NOW }, {}, 0],
    ['revocation', { revokedAt: NOW }, {}, 0],
    ['template', {}, { body: 'Unreviewed body' }, 0],
    ['sender', {}, { fromAddress: 'other@example.org' }, 0],
    ['mailbox', {}, { mailboxAccountId: 'mailbox-2' }, 0],
    ['recipient rule', {}, { toAddresses: ['pilot@blocked.example.com'] }, 0],
  ])(
    '%s falls back to the unchanged kit refusal without sending',
    async (_name, row, mail, used) => {
      const h = harness(approval(row), message(mail), used as number);
      try {
        await h.service.approveAgentInboxItem(
          'workspace-1',
          'demo-agent',
          'inbox-1',
          null,
          false,
          true,
        );
        throw new Error('expected refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).getResponse()).toMatchObject({
          reason: 'kit_missing',
        });
      }
      expect(h.engine).not.toHaveBeenCalled();
      expect(h.tx.standingApprovalUse.createMany).not.toHaveBeenCalled();
    },
  );

  it('still accepts an approved per-kit grant when the standing cap is full', async () => {
    const kit = {
      ...buildAgentSendKitDefinition({
        ...definition,
        fromAddress: 'team@example.org',
        recipients: ['pilot@example.com'],
        capPerDay: 2,
      }),
      state: 'APPROVED',
      expiresAt: new Date(NOW.getTime() + DAY_MS),
    };
    const h = harness(approval(), message({ kitId: 'kit-1' }), 2, kit);
    await h.service.approveAgentInboxItem(
      'workspace-1',
      'demo-agent',
      'inbox-1',
      null,
      false,
      true,
    );
    expect(h.tx.agentSendKit.findFirst).toHaveBeenCalled();
    expect(h.engine).toHaveBeenCalledTimes(1);
  });

  it('a replacement approval inherits today’s reservations from earlier campaign revisions', async () => {
    const h = harness(approval({ id: 'approval-2' }));
    const earlierReservations = [
      { approvalId: 'approval-1', campaignKey: 'Preview' },
      { approvalId: 'approval-1', campaignKey: 'Preview' },
    ];
    h.tx.standingApprovalUse.count.mockImplementation(
      async ({ where }) =>
        earlierReservations.filter(
          (use) =>
            where.approval?.is?.campaignKey === use.campaignKey ||
            where.approvalId === use.approvalId,
        ).length,
    );
    expect(await h.standing.reserve(h.tx, 'workspace-1', message())).toBeNull();
    expect(h.tx.standingApprovalUse.createMany).not.toHaveBeenCalled();
  });

  it('rechecks revocation after acquiring the row lock', async () => {
    const h = harness();
    h.tx.standingApproval.findFirst.mockResolvedValue(approval({ revokedAt: NOW }));
    expect(await h.standing.reserve(h.tx, 'workspace-1', message())).toBeNull();
    expect(h.tx.standingApprovalUse.createMany).not.toHaveBeenCalled();
  });

  it('refuses duplicate message reservations', async () => {
    const h = harness();
    h.tx.standingApprovalUse.createMany.mockResolvedValue({ count: 0 });
    await expect(h.standing.reserve(h.tx, 'workspace-1', message())).rejects.toThrow('already has');
    expect(h.tx.emailMessage.update).not.toHaveBeenCalled();
  });

  it('serializes concurrent cap reservations, using New York calendar boundaries', async () => {
    jest.setSystemTime(new Date('2026-10-26T00:30:00Z'));
    const rows: any[] = [];
    let nextLock = Promise.resolve();
    const service = new StandingApprovalsService({} as any, {} as any, {} as any);
    const run = async (id: string) => {
      let unlock: (() => void) | undefined;
      const tx: any = {
        $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
          expect(parts.join('')).toContain('FOR UPDATE');
          const previous = nextLock;
          nextLock = new Promise<void>((resolve) => {
            unlock = resolve;
          });
          await previous;
        }),
        standingApproval: { findMany: async () => [approval()], findFirst: async () => approval() },
        standingApprovalUse: {
          count: async ({ where }) => {
            expect(where.workspaceId).toBe('workspace-1');
            expect(where.reservedAt).toEqual({
              gte: new Date('2026-10-25T04:00:00Z'),
              lt: new Date('2026-10-26T04:00:00Z'),
            });
            return rows.length;
          },
          createMany: async ({ data }) => {
            rows.push(data);
            return { count: 1 };
          },
        },
        emailMessage: { update: async () => ({}) },
      };
      try {
        return await service.reserve(tx, 'workspace-1', message({ id }));
      } finally {
        unlock?.();
      }
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => run(`message-${index}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(rows).toHaveLength(2);
  });
});

describe('human campaign lifecycle', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  function lifecycle() {
    const user: any = { id: 'human-1', keycloakId: 'reviewer-sub', isActive: true };
    const row = approval({ approvedAt: null });
    const tx: any = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      mailboxAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'mailbox-1',
          emailAddress: 'team@example.org',
          ownerKind: 'SHARED',
        }),
        findMany: jest.fn().mockResolvedValue([{ id: 'mailbox-1' }]),
      },
      standingApproval: {
        create: jest.fn(async ({ data }) => ({ ...data, approvedAt: null, revokedAt: null })),
        findFirst: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      standingApprovalUse: { count: jest.fn().mockResolvedValue(0) },
    };
    const prisma: any = { withWorkspace: jest.fn((_ws, _uid, fn) => fn(tx)) };
    const links: any = { issue: jest.fn().mockResolvedValue('/approve#review') };
    const notifier: any = { notifyApprovalPending: jest.fn().mockResolvedValue(undefined) };
    const service = new StandingApprovalsService(prisma, links, notifier);
    const input = {
      campaign_key: 'Preview',
      mailbox_id: 'mailbox-1',
      subject: 'Preview invitation',
      body_template: definition.bodyTemplate,
      cap_per_day: 5,
      expires_at: new Date(NOW.getTime() + DAY_MS).toISOString(),
    };
    return { user, row, tx, prisma, links, notifier, service, input };
  }

  it('creates an immutable pending request bound to the selected sender and includes its link in the notice', async () => {
    const h = lifecycle();
    const result = await h.service.request('workspace-1', h.user, h.input);
    expect(result).toMatchObject({
      approvedAt: null,
      fromAddress: 'team@example.org',
      capPerDay: 5,
      templateSha256: standingTemplateSha256(definition),
      createdBy: 'reviewer-sub',
      approval_url: '/approve#review',
    });
    expect(h.tx.mailboxAccount.findFirst).toHaveBeenCalledWith({
      where: { id: 'mailbox-1', workspaceId: 'workspace-1' },
    });
    expect(h.tx.standingApproval.updateMany).not.toHaveBeenCalled();
    expect(h.notifier.notifyApprovalPending).toHaveBeenCalledWith(
      expect.objectContaining({ approvalUrl: '/approve#review' }),
    );
  });

  it('rejects oversized expiry, zero cap, and unknown recipient rules before writing', async () => {
    const h = lifecycle();
    for (const change of [
      { expires_at: new Date(NOW.getTime() + 91 * DAY_MS).toISOString() },
      { cap_per_day: 0 },
      { recipient_rules: { allowEverything: true } },
    ])
      await expect(
        h.service.request('workspace-1', h.user, { ...h.input, ...change }),
      ).rejects.toThrow(BadRequestException);
    expect(h.prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it('approves only the reviewed definition and supersedes earlier campaign grants atomically', async () => {
    const h = lifecycle();
    await expect(
      h.service.approve('workspace-1', h.user, h.row.id, '0'.repeat(64)),
    ).rejects.toThrow('definition changed');
    expect(h.tx.standingApproval.updateMany).not.toHaveBeenCalled();
    await expect(
      h.service.approve('workspace-1', h.user, h.row.id, standingBinding(h.row).definitionSha256),
    ).resolves.toMatchObject({ approved: true });
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.standingApproval.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'workspace-1',
          campaignKey: 'Preview',
          id: { not: h.row.id },
        }),
        data: { revokedAt: NOW, revokedBy: 'reviewer-sub' },
      }),
    );
    expect(h.tx.standingApproval.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: 'workspace-1',
          approvedAt: null,
          revokedAt: null,
        }),
        data: { approvedAt: NOW, approvedBy: 'reviewer-sub' },
      }),
    );
  });

  it('revokes with a workspace predicate and never changes the approved definition', async () => {
    const h = lifecycle();
    await expect(h.service.revoke('workspace-1', h.user, h.row.id)).resolves.toEqual({
      id: h.row.id,
      revoked: true,
    });
    expect(h.tx.standingApproval.updateMany).toHaveBeenCalledWith({
      where: { id: h.row.id, workspaceId: 'workspace-1', revokedAt: null },
      data: { revokedAt: NOW, revokedBy: 'reviewer-sub' },
    });
  });

  it('cannot approve or revoke a campaign outside the workspace', async () => {
    const h = lifecycle();
    h.tx.standingApproval.findFirst.mockResolvedValue(null);
    await expect(
      h.service.approve('workspace-2', h.user, h.row.id, standingBinding(h.row).definitionSha256),
    ).rejects.toThrow('not found');
    await expect(h.service.revoke('workspace-2', h.user, h.row.id)).rejects.toThrow('not found');
    expect(h.tx.standingApproval.updateMany).not.toHaveBeenCalled();
  });
});
