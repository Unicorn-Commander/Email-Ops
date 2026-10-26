import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildAgentSendKitDefinition, agentSendKitTemplateSha256 } from '../email/agent-send-kit';
import { ApprovalLinksService, kitTarget, standingTarget } from './approval-links.service';
import { ApprovalTokensService } from './approval-tokens.service';
import { ApprovalController } from './approval.controller';
import {
  ApprovalSessionService,
  APPROVAL_COOKIE,
  APPROVAL_COOKIE_OPTIONS,
} from './approval-session.service';
import { StandingApprovalsService } from './standing-approvals.service';
import { DAY_MS, standingTemplate, standingTemplateSha256 } from './standing-approval';

const NOW = new Date('2026-10-26T16:00:00Z');
const human: any = {
  id: 'human-1',
  keycloakId: 'human-sub',
  email: 'reviewer@example.com',
  isActive: true,
};
function harness() {
  const definition = buildAgentSendKitDefinition({
    bodyTemplate: 'Hello {first_name}.',
    subjects: ['Preview'],
    recipients: ['pilot@example.com'],
    fromAddress: 'team@example.org',
    capPerDay: 5,
  });
  const kit: any = {
    ...definition,
    kitId: 'kit-1',
    workspaceId: 'workspace-1',
    state: 'PROPOSED',
    templateSha256: agentSendKitTemplateSha256(definition),
    title: 'Preview kit',
    expiresAt: new Date(NOW.getTime() + 5 * DAY_MS),
    proposedAt: NOW,
  };
  const template = standingTemplate({ bodyTemplate: 'Hello {first_name}.', subjects: ['Preview'] });
  const standing: any = {
    ...template,
    id: 'campaign-1',
    workspaceId: 'workspace-1',
    campaignKey: 'Preview campaign',
    mailboxId: 'mailbox-1',
    fromAddress: 'team@example.org',
    templateSha256: standingTemplateSha256(template),
    recipientRules: { blockedDomains: ['blocked.example.com'], allowedDomains: [] },
    capPerDay: 5,
    approvedAt: null,
    revokedAt: null,
    expiresAt: new Date(NOW.getTime() + 5 * DAY_MS),
  };
  const saved: any[] = [];
  const sessions: any[] = [];
  const tokens = new ApprovalTokensService(
    new ConfigService({
      JWT_SECRET: ['fixture', 'approval', 'signing', 'key'].join('-'),
      FRONTEND_URL: 'https://mail.example.com',
    }),
  );
  const links = new ApprovalLinksService(tokens);
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    approvalLink: {
      findFirst: jest.fn(
        async ({ where }) =>
          saved.find((row) =>
            where.id
              ? row.id === where.id && row.workspaceId === where.workspaceId
              : row.workspaceId === where.workspaceId &&
                row.targetId === where.targetId &&
                row.definitionSha256 === where.definitionSha256 &&
                row.recipientSha256 === where.recipientSha256 &&
                !row.consumedAt &&
                row.expiresAt > new Date(),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }) => {
        const row = { ...data, consumedAt: null };
        saved.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = saved.find(
          (value) => value.id === where.id && !value.consumedAt && value.expiresAt > new Date(),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    agentSendKit: {
      findFirst: jest.fn(async () => kit),
      update: jest.fn(async ({ data }) => Object.assign(kit, data)),
    },
    standingApproval: {
      findFirst: jest.fn(async () => standing),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async ({ where, data }) => {
        if (where.id === standing.id) Object.assign(standing, data);
        return { count: 1 };
      }),
    },
    mailboxAccount: {
      findFirst: jest.fn(async () => ({ id: 'mailbox-1', ownerKind: 'SHARED' })),
      findMany: jest.fn(async () => [{ id: 'mailbox-1' }]),
    },
    approvalSession: {
      create: jest.fn(async ({ data }) => {
        sessions.push({ ...data, revokedAt: null });
        return data;
      }),
      findFirst: jest.fn(
        async ({ where }) =>
          sessions.find(
            (row) =>
              row.id === where.id &&
              row.workspaceId === where.workspaceId &&
              !row.revokedAt &&
              row.expiresAt > new Date(),
          ) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        sessions
          .filter((row) => row.id === where.id && row.userId === where.userId)
          .forEach((row) => Object.assign(row, data));
        return { count: 1 };
      }),
    },
    user: { findUnique: jest.fn(async () => human) },
  };
  const prisma: any = { withWorkspace: jest.fn((_ws, _uid, fn) => fn(tx)) };
  const sessionService = new ApprovalSessionService(prisma, tokens);
  const standingService = new StandingApprovalsService(prisma, links, {} as any);
  const membership: any = { assertCanReviewInbox: jest.fn().mockResolvedValue('workspace-1') };
  const controller = new ApprovalController(
    prisma,
    links,
    standingService,
    sessionService,
    membership,
  );
  const issue = async (kind: 'send-kit' | 'standing' = 'send-kit') => {
    const url = await links.issue(
      tx,
      kind === 'send-kit' ? kitTarget(kit) : standingTarget(standing),
    );
    return { url, token: new URLSearchParams(new URL(url).hash.slice(1)).get('token')! };
  };
  return {
    tx,
    kit,
    standing,
    saved,
    sessions,
    tokens,
    links,
    issue,
    controller,
    sessionService,
    membership,
  };
}

describe('signed human approval links', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  it('puts the signed link in a URL fragment and expires within 24 hours', async () => {
    const h = harness();
    const { url, token } = await h.issue();
    expect(new URL(url).search).toBe('');
    expect(new URL(url).pathname).toBe('/approve');
    expect(h.saved[0].expiresAt).toEqual(new Date(NOW.getTime() + DAY_MS));
    expect(h.tokens.verify<any>('link', token)).toMatchObject({
      targetId: 'kit-1',
      workspaceId: 'workspace-1',
      recipientSha256: kitTarget(h.kit).recipientSha256,
    });
    expect((await h.issue()).token).toBe(token);
  });

  it('never consumes a link while previewing and shows the full summary to a human', async () => {
    const h = harness();
    const { token } = await h.issue();
    await expect(
      h.controller.preview('workspace-1', human, 'send-kit', 'kit-1', { token }),
    ).resolves.toMatchObject({
      kit: { bodyTemplate: 'Hello {first_name}.', recipients: ['pilot@example.com'] },
      canRemember: true,
    });
    expect(h.saved[0].consumedAt).toBeNull();
    expect(h.tx.agentSendKit.update).not.toHaveBeenCalled();
  });

  it('approves once with a human session and enrolls a restricted secure phone cookie', async () => {
    const h = harness();
    const { token } = await h.issue();
    const response: any = { cookie: jest.fn() };
    await expect(
      h.controller.approve(
        'workspace-1',
        human,
        'send-kit',
        'kit-1',
        { token, remember: true },
        response,
      ),
    ).resolves.toEqual({ id: 'kit-1', approved: true });
    expect(h.kit).toMatchObject({ state: 'APPROVED', approvedBy: 'human-sub' });
    expect(h.saved[0].consumedAt).toEqual(NOW);
    expect(response.cookie).toHaveBeenCalledWith(APPROVAL_COOKIE, expect.any(String), {
      ...APPROVAL_COOKIE_OPTIONS,
      maxAge: 30 * DAY_MS,
    });
    const cookie = response.cookie.mock.calls[0][1];
    await expect(h.sessionService.resolve(cookie)).resolves.toMatchObject({
      id: 'human-1',
      __approvalSession: { workspaceId: 'workspace-1' },
    });
    await expect(
      h.controller.approve('workspace-1', human, 'send-kit', 'kit-1', { token }, response),
    ).rejects.toThrow(ConflictException);
  });

  it('a standing request link grants only its reviewed campaign definition', async () => {
    const h = harness();
    const { token } = await h.issue('standing');
    await h.controller.approve(
      'workspace-1',
      human,
      'standing',
      'campaign-1',
      { token },
      {} as any,
    );
    expect(h.standing).toMatchObject({ approvedAt: NOW, approvedBy: 'human-sub', capPerDay: 5 });
    expect(h.saved[0].consumedAt).toEqual(NOW);
    expect(h.tx.agentSendKit.update).not.toHaveBeenCalled();
  });

  it.each(['send-kit', 'standing'] as const)('%s refuses an expired link', async (kind) => {
    const h = harness();
    const { token } = await h.issue(kind);
    jest.setSystemTime(new Date(NOW.getTime() + DAY_MS));
    await expect(
      h.links.review(
        h.tx,
        'workspace-1',
        'human-sub',
        kind,
        kind === 'send-kit' ? 'kit-1' : 'campaign-1',
        token,
        true,
      ),
    ).rejects.toThrow(ConflictException);
    expect(h.saved[0].consumedAt).toBeNull();
  });

  it('rechecks expiry after waiting for a target lock', async () => {
    const h = harness();
    const { token } = await h.issue();
    h.tx.$queryRaw.mockImplementation(async () => {
      jest.setSystemTime(new Date(NOW.getTime() + DAY_MS));
      return [];
    });
    await expect(
      h.links.review(h.tx, 'workspace-1', 'human-sub', 'send-kit', 'kit-1', token, true),
    ).rejects.toThrow(ConflictException);
    expect(h.saved[0].consumedAt).toBeNull();
  });

  it('refuses payload and signature tampering', async () => {
    const h = harness();
    const { token } = await h.issue();
    const [data, signature] = token.split('.');
    const changed = { ...JSON.parse(Buffer.from(data, 'base64url').toString()), targetId: 'kit-2' };
    for (const bad of [
      `${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${signature}`,
      `${data}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`,
    ]) {
      await expect(
        h.links.review(h.tx, 'workspace-1', 'human-sub', 'send-kit', 'kit-1', bad, true),
      ).rejects.toThrow(UnauthorizedException);
    }
  });

  it.each([
    ['workspace-2', 'send-kit', 'kit-1'],
    ['workspace-1', 'send-kit', 'kit-2'],
    ['workspace-1', 'standing', 'kit-1'],
  ])('refuses a different workspace/kit/kind %s %s %s', async (ws, kind, id) => {
    const h = harness();
    const { token } = await h.issue();
    await expect(
      h.links.review(h.tx, ws, 'human-sub', kind as any, id, token, true),
    ).rejects.toThrow(NotFoundException);
    expect(h.tx.agentSendKit.update).not.toHaveBeenCalled();
  });

  it.each(['recipients', 'template', 'expiry'])('refuses a replaced kit %s', async (field) => {
    const h = harness();
    const { token } = await h.issue();
    if (field === 'recipients') h.kit.recipientHashes = ['0'.repeat(64)];
    if (field === 'template') h.kit.bodyTemplate = 'Changed body';
    if (field === 'expiry') h.kit.expiresAt = new Date(NOW.getTime() + 6 * DAY_MS);
    await expect(
      h.links.review(h.tx, 'workspace-1', 'human-sub', 'send-kit', 'kit-1', token, true),
    ).rejects.toThrow('changed or expired');
  });

  it('refuses a changed standing recipient policy or cap', async () => {
    const h = harness();
    const { token } = await h.issue('standing');
    h.standing.recipientRules = { blockedDomains: [], allowedDomains: [] };
    h.standing.capPerDay = 100;
    await expect(
      h.links.review(h.tx, 'workspace-1', 'human-sub', 'standing', 'campaign-1', token, true),
    ).rejects.toThrow('changed or expired');
  });

  it('only one concurrent consumption wins', async () => {
    const h = harness();
    const { token } = await h.issue();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        h.links.review(h.tx, 'workspace-1', 'human-sub', 'send-kit', 'kit-1', token, true),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('rejects lost review authority before consuming a valid link', async () => {
    const h = harness();
    const { token } = await h.issue();
    h.membership.assertCanReviewInbox.mockRejectedValue(new ForbiddenException());
    await expect(
      h.controller.approve('workspace-1', human, 'send-kit', 'kit-1', { token }, {} as any),
    ).rejects.toThrow(ForbiddenException);
    expect(h.saved[0].consumedAt).toBeNull();
  });

  it('enforces the existing private-mailbox owner fence', async () => {
    const h = harness();
    const { token } = await h.issue();
    h.tx.mailboxAccount.findFirst.mockResolvedValue({
      id: 'mailbox-1',
      ownerKind: 'HUMAN',
      ownerKey: 'someone-else',
    });
    h.tx.user.findFirst = jest.fn().mockResolvedValue(human);
    await expect(
      h.controller.approve('workspace-1', human, 'send-kit', 'kit-1', { token }, {} as any),
    ).rejects.toThrow(ForbiddenException);
    expect(h.saved[0].consumedAt).toBeNull();
  });

  it('expires and revokes remembered sessions and never renews from a restricted session', async () => {
    const h = harness();
    const token = await h.sessionService.create('workspace-1', human);
    const remembered = await h.sessionService.resolve(token);
    await expect(h.sessionService.create('workspace-1', remembered)).rejects.toThrow(
      ForbiddenException,
    );
    await h.sessionService.revokeToken(token, human);
    await expect(h.sessionService.resolve(token)).rejects.toThrow(UnauthorizedException);
    const another = await h.sessionService.create('workspace-1', human);
    jest.setSystemTime(new Date(NOW.getTime() + 30 * DAY_MS));
    await expect(h.sessionService.resolve(another)).rejects.toThrow(UnauthorizedException);
    expect(() => h.tokens.verify('link', another)).toThrow(UnauthorizedException);
  });
});
