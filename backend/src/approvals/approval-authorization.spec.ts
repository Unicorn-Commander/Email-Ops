import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { ExplicitCredentialGuard } from '../auth/guards/explicit-credential.guard';
import { EmailOpsTools } from '../mcp/mcp.tools';
import { AgentInboxController } from '../agent-inbox/agent-inbox.controller';
import { StandingApprovalsController } from './standing-approvals.controller';
import { StandingApprovalsService } from './standing-approvals.service';
import { ApprovalController } from './approval.controller';
import { ApprovalSessionGuard } from './approval-session.guard';
import { ApprovalSessionService, APPROVAL_COOKIE } from './approval-session.service';
import { assertHumanApproval } from './human-approval';

const human: any = {
  id: 'human-1',
  keycloakId: 'human-sub',
  email: 'reviewer@example.com',
  isActive: true,
};
const agents = [
  ['PAT', { __patAuth: { scopes: ['*'] } }],
  ['federation actor', { __isFederationActor: true }],
  ['federated user', { __isFederationAuth: true }],
] as const;

describe('all approval authority routes refuse agent identities', () => {
  it.each(agents)(
    '%s receives 403 on every standing REST and MCP operation and legacy kit approval',
    async (_label, tag) => {
      const user: any = { ...human, ...tag };
      const service: any = {
        request: jest.fn(),
        list: jest.fn(),
        approve: jest.fn(),
        revoke: jest.fn(),
      };
      const membership: any = { assertCanReviewInbox: jest.fn() };
      const controller = new StandingApprovalsController(service, membership);
      const mcp = new EmailOpsTools(
        membership,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        service,
      );
      const legacy = new AgentInboxController({} as any, membership);
      const phone = new ApprovalController({} as any, {} as any, service, {} as any, membership);
      const operations = [
        () => controller.list('workspace-1', user),
        () => controller.request('workspace-1', user, {} as any),
        () =>
          controller.approve('workspace-1', user, 'approval-1', {
            definition_sha256: '0'.repeat(64),
          }),
        () => controller.revoke('workspace-1', user, 'approval-1'),
        () => mcp.requestStandingApproval(user, {} as any),
        () => mcp.listStandingApprovals(user, {}),
        () =>
          mcp.approveStandingApproval(user, {
            id: 'approval-1',
            definition_sha256: '0'.repeat(64),
          }),
        () => mcp.revokeStandingApproval(user, { id: 'approval-1' }),
        () => mcp.approveSendKit(user, { kit_id: 'kit-1', template_sha256: '0'.repeat(64) }),
        () => mcp.rejectSendKit(user, { kit_id: 'kit-1' }),
        () => legacy.approveSendKit('workspace-1', user, {} as any),
        () => legacy.approveSendKitProposal('workspace-1', user, 'kit-1', {} as any),
        () => legacy.rejectSendKit('workspace-1', user, 'kit-1', {}),
        () => phone.preview('workspace-1', user, 'send-kit', 'kit-1', {} as any),
        () => phone.approve('workspace-1', user, 'send-kit', 'kit-1', {} as any, {} as any),
        () => phone.forget('workspace-1', user, {} as any, {} as any),
      ];
      for (const operation of operations)
        await expect(operation()).rejects.toBeInstanceOf(ForbiddenException);
      expect(membership.assertCanReviewInbox).not.toHaveBeenCalled();
      for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled();
    },
  );

  it.each(agents)(
    '%s is also refused by the underlying grant/session services',
    async (_label, tag) => {
      const user: any = { ...human, ...tag };
      const prisma: any = { withWorkspace: jest.fn() };
      const standing = new StandingApprovalsService(prisma, {} as any, {} as any);
      const sessions = new ApprovalSessionService(prisma, {} as any);
      for (const operation of [
        () => standing.request('workspace-1', user, {} as any),
        () => standing.approve('workspace-1', user, 'approval-1', '0'.repeat(64)),
        () => standing.approveInTx({} as any, 'workspace-1', user, {} as any, '0'.repeat(64)),
        () => standing.revoke('workspace-1', user, 'approval-1'),
        () => sessions.create('workspace-1', user),
      ])
        await expect(operation()).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withWorkspace).not.toHaveBeenCalled();
    },
  );

  it('tags federation tokens even when they resolve to a real human user row', async () => {
    const config = new ConfigService({
      JWT_SECRET: ['fixture', 'auth', 'key'].join('-'),
      BRIGADE_TRUSTED_ISSUERS: 'https://broker.example.com',
      BRIGADE_EXPECTED_AUDIENCE: 'email-ops',
    });
    const strategy = new JwtStrategy(config, {
      validateJwtPayload: jest.fn().mockResolvedValue({ ...human }),
    } as any);
    const user = await strategy.validate({
      iss: 'https://broker.example.com',
      aud: 'email-ops',
      sub: 'human-sub',
    });
    expect(() => assertHumanApproval(user)).toThrow(ForbiddenException);
  });
});

describe('phone session authentication and confinement', () => {
  function guardWith(
    user?: any,
    opts: {
      cookie?: string;
      bearer?: string;
      jwtError?: Error;
      workspace?: string;
      header?: string;
    } = {},
  ) {
    const req: any = {
      method: 'POST',
      params: { workspaceId: opts.workspace ?? 'workspace-1' },
      headers: {
        cookie: opts.cookie,
        authorization: opts.bearer,
        'x-email-ops-approval': opts.header ?? '1',
      },
    };
    const context: any = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    const jwt: any = {
      canActivate: jest.fn(async () => {
        if (opts.bearer) expect(req.headers.cookie).toBeUndefined();
        if (opts.jwtError) throw opts.jwtError;
        if (!user) throw new UnauthorizedException();
        req.user = user;
        return true;
      }),
    };
    const sessions: any = {
      resolve: jest.fn().mockResolvedValue({
        ...human,
        __approvalSession: { workspaceId: 'workspace-1', id: 'session-1' },
      }),
    };
    return { req, context, jwt, sessions, guard: new ApprovalSessionGuard(jwt, sessions) };
  }

  it('a signed link alone with no session is unauthorized', async () => {
    const h = guardWith();
    await expect(h.guard.canActivate(h.context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.sessions.resolve).not.toHaveBeenCalled();
  });

  it.each(agents)('%s cannot use a remembered human cookie to approve', async (_label, tag) => {
    const h = guardWith(
      { ...human, ...tag },
      { bearer: ['Bearer', 'agent-credential'].join(' '), cookie: `${APPROVAL_COOKIE}=remembered` },
    );
    await expect(h.guard.canActivate(h.context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.sessions.resolve).not.toHaveBeenCalled();
  });

  it('accepts a signed-in human session', async () => {
    const h = guardWith(human);
    expect(await h.guard.canActivate(h.context)).toBe(true);
    expect(h.sessions.resolve).not.toHaveBeenCalled();
  });

  it('uses a limited cookie when the full web session expires', async () => {
    const h = guardWith(undefined, {
      cookie: `${APPROVAL_COOKIE}=remembered`,
      jwtError: new UnauthorizedException(),
    });
    expect(await h.guard.canActivate(h.context)).toBe(true);
    expect(h.req.user.__approvalSession.workspaceId).toBe('workspace-1');
  });

  it('never falls back from an invalid explicit bearer to a human cookie', async () => {
    const h = guardWith(undefined, {
      bearer: ['Bearer', 'expired-agent'].join(' '),
      cookie: `${APPROVAL_COOKIE}=remembered`,
    });
    await expect(h.guard.canActivate(h.context)).rejects.toThrow(UnauthorizedException);
    expect(h.sessions.resolve).not.toHaveBeenCalled();
  });

  it('refuses a different workspace and cross-site form submissions', async () => {
    const different = guardWith(undefined, {
      workspace: 'workspace-2',
      cookie: `${APPROVAL_COOKIE}=remembered`,
    });
    await expect(different.guard.canActivate(different.context)).rejects.toThrow(
      ForbiddenException,
    );
    const form = guardWith(human, { header: '' });
    await expect(form.guard.canActivate(form.context)).rejects.toThrow(ForbiddenException);
    const crossSite = guardWith(human);
    crossSite.req.headers['sec-fetch-site'] = 'cross-site';
    await expect(crossSite.guard.canActivate(crossSite.context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('standing and MCP authentication prefer an explicit credential over a human cookie', async () => {
    const req: any = {
      headers: {
        cookie: 'access_token=' + 'human-cookie',
        authorization: ['Bearer', 'agent-credential'].join(' '),
      },
    };
    const context: any = { switchToHttp: () => ({ getRequest: () => req }) };
    const guard = new ExplicitCredentialGuard({
      canActivate: jest.fn(async () => {
        expect(req.headers.cookie).toBeUndefined();
        req.user = { ...human, __isFederationAuth: true };
        return true;
      }),
    } as any);
    expect(await guard.canActivate(context)).toBe(true);
    expect(req.headers.cookie).toBe('access_token=' + 'human-cookie');
    expect(() => assertHumanApproval(req.user)).toThrow(ForbiddenException);
  });

  it('ordinary JWT routes do not extract the approval-only cookie', () => {
    const strategy: any = new JwtStrategy(
      new ConfigService({
        JWT_SECRET: ['fixture', 'auth', 'key'].join('-'),
        BRIGADE_TRUSTED_ISSUERS: '',
      }),
      {} as any,
    );
    expect(
      strategy._jwtFromRequest({ headers: { cookie: `${APPROVAL_COOKIE}=remembered` } }),
    ).toBeNull();
    expect(Reflect.getMetadata(GUARDS_METADATA, ApprovalController)).toContain(
      ApprovalSessionGuard,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, StandingApprovalsController)).toContain(
      ExplicitCredentialGuard,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, StandingApprovalsController)).not.toContain(
      ApprovalSessionGuard,
    );
  });
});
