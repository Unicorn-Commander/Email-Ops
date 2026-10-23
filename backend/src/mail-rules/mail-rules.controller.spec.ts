import { NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { MailRulesController } from './mail-rules.controller';
import { MailRulesService } from './mail-rules.service';

/**
 * MailRulesController: prove the PINNED REST contract shapes + that every route
 * delegates with the resolved workspace + acting sub, and that a service miss
 * maps to 404. Service is mocked (no DB / engine).
 */
describe('MailRulesController', () => {
  const WS = '0190a000-7e57-7000-8000-0000000000c1';

  function user(): User {
    const u: WithWorkspaceClaim = {
      id: 'local-1',
      email: 'aaron@magicunicorn.tech',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      picture: null,
      keycloakId: 'kc-aaron',
      passwordHash: null,
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __ucUid: 'kc-aaron',
      __entitlements: [],
      __workspaceClaim: WS,
    };
    return u as User;
  }

  const view = {
    id: 'rule-1',
    mailbox_id: 'mb-1',
    name: 'Newsletters',
    enabled: true,
    priority: 10,
    match: { all: [{ field: 'fromDomain', op: 'equals', value: 'news.test' }] },
    actions: [{ type: 'ARCHIVE' }],
    hit_count: 0,
    last_hit_at: null,
    created_at: '2026-07-18T10:00:00.000Z',
    updated_at: '2026-07-18T10:00:00.000Z',
  };

  function make(rules: Partial<jest.Mocked<MailRulesService>>) {
    return new MailRulesController(rules as unknown as MailRulesService);
  }

  it('pins the nested route + guards (JwtAuthGuard, WorkspaceMembershipGuard)', () => {
    expect(Reflect.getMetadata('path', MailRulesController)).toBe(
      'workspaces/:workspaceId/mailboxes/:mailboxId/rules',
    );
    const guards = Reflect.getMetadata('__guards__', MailRulesController) as unknown[];
    expect(guards).toEqual([JwtAuthGuard, WorkspaceMembershipGuard]);
  });

  it('GET returns { rules } and delegates with the resolved workspace + sub', async () => {
    const list = jest.fn().mockResolvedValue([view]);
    const out = await make({ list }).list(WS, user(), 'mb-1');
    expect(list).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1');
    expect(out).toEqual({ rules: [view] });
  });

  it('POST delegates the body fields and returns the created view unwrapped', async () => {
    const create = jest.fn().mockResolvedValue(view);
    const body = {
      name: 'Newsletters',
      enabled: true,
      priority: 10,
      match: { all: [{ field: 'fromDomain', op: 'equals', value: 'news.test' }] },
      actions: [{ type: 'ARCHIVE' }],
    };
    const out = await make({ create }).create(WS, user(), 'mb-1', body as never);
    expect(create).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1', {
      name: 'Newsletters',
      enabled: true,
      priority: 10,
      match: body.match,
      actions: body.actions,
    });
    expect(out).toEqual(view);
  });

  it('PATCH delegates a partial and maps a service null to 404', async () => {
    const update = jest.fn().mockResolvedValue(view);
    const out = await make({ update }).update(WS, user(), 'mb-1', 'rule-1', { enabled: false } as never);
    expect(update).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1', 'rule-1', expect.objectContaining({
      enabled: false,
    }));
    expect(out).toEqual(view);

    const miss = jest.fn().mockResolvedValue(null);
    await expect(
      make({ update: miss }).update(WS, user(), 'mb-1', 'nope', {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('DELETE returns { ok: true } and maps a miss to 404', async () => {
    const remove = jest.fn().mockResolvedValue(true);
    const out = await make({ remove }).remove(WS, user(), 'mb-1', 'rule-1');
    expect(remove).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1', 'rule-1');
    expect(out).toEqual({ ok: true });

    const miss = jest.fn().mockResolvedValue(false);
    await expect(make({ remove: miss }).remove(WS, user(), 'mb-1', 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
