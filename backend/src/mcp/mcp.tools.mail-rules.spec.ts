import { BadRequestException } from '@nestjs/common';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { MailRulesService } from '../mail-rules/mail-rules.service';
import { MailRulesTools } from './mcp.tools';

/**
 * MailRulesTools dispatch: the MCP twin of the rules REST routes. These specs
 * pin the seam only — workspace resolution via the membership gate, snake_case
 * pass-through into the SAME MailRulesService the REST controller uses, the
 * standard not-found shapes, and that service validation errors surface (never
 * swallowed). Rule semantics themselves are covered by the mail-rules specs.
 */
describe('MailRulesTools', () => {
  const user = {
    id: 'u1',
    email: 'user@example.test',
    __ucUid: 'uc-user-1',
  } as unknown as User;

  const ruleView = {
    id: 'rule-1',
    mailbox_id: 'mb-1',
    name: 'Newsletters to archive',
    enabled: true,
    priority: 10,
    match: { all: [{ field: 'fromDomain', op: 'equals', value: 'news.test' }] },
    actions: [{ type: 'ARCHIVE' }],
    hit_count: 0,
    last_hit_at: null,
    created_at: '2026-07-18T12:00:00.000Z',
    updated_at: '2026-07-18T12:00:00.000Z',
  };

  const membership = {
    resolveAndAuthorize: jest.fn(),
  } as unknown as MembershipService;

  const mailRules = {
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  } as unknown as MailRulesService;

  beforeEach(() => {
    jest.clearAllMocks();
    (membership.resolveAndAuthorize as jest.Mock).mockResolvedValue('ws-1');
  });

  function tools() {
    return new MailRulesTools(membership, mailRules);
  }

  it('lists a mailbox’s rules through the resolved workspace (same service as REST)', async () => {
    (mailRules.list as jest.Mock).mockResolvedValue([ruleView]);

    await expect(
      tools().listMailRules(user, { workspace_id: 'ws-1', mailbox_id: 'mb-1' }),
    ).resolves.toEqual({ rules: [ruleView], count: 1 });

    expect(membership.resolveAndAuthorize).toHaveBeenCalledWith(user, 'ws-1');
    expect(mailRules.list).toHaveBeenCalledWith('ws-1', 'uc-user-1', 'mb-1');
  });

  it('creates through the service with the REST input shape', async () => {
    (mailRules.create as jest.Mock).mockResolvedValue(ruleView);

    await expect(
      tools().createMailRule(user, {
        mailbox_id: 'mb-1',
        name: 'Newsletters to archive',
        match: { all: [{ field: 'fromDomain', op: 'equals', value: 'news.test' }] },
        actions: [{ type: 'ARCHIVE' }],
        enabled: true,
        priority: 10,
      }),
    ).resolves.toEqual(ruleView);

    expect(mailRules.create).toHaveBeenCalledWith('ws-1', 'uc-user-1', 'mb-1', {
      name: 'Newsletters to archive',
      enabled: true,
      priority: 10,
      match: { all: [{ field: 'fromDomain', op: 'equals', value: 'news.test' }] },
      actions: [{ type: 'ARCHIVE' }],
    });
  });

  it('surfaces the service’s validation error on create (never swallowed)', async () => {
    (mailRules.create as jest.Mock).mockRejectedValue(
      new BadRequestException('actions must contain at least one valid action'),
    );

    await expect(
      tools().createMailRule(user, {
        mailbox_id: 'mb-1',
        name: 'Bad rule',
        match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
        actions: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('maps a null update to the standard not-found shape', async () => {
    (mailRules.update as jest.Mock).mockResolvedValue(null);

    await expect(
      tools().updateMailRule(user, { mailbox_id: 'mb-1', rule_id: 'missing', enabled: false }),
    ).resolves.toEqual({ status: 'not_found', reason: 'rule not found in this mailbox' });
  });

  it('maps delete to { ok:true } or the standard not-found reason', async () => {
    (mailRules.remove as jest.Mock).mockResolvedValueOnce(true);
    await expect(
      tools().deleteMailRule(user, { mailbox_id: 'mb-1', rule_id: 'rule-1' }),
    ).resolves.toEqual({ ok: true });
    expect(mailRules.remove).toHaveBeenCalledWith('ws-1', 'uc-user-1', 'mb-1', 'rule-1');

    (mailRules.remove as jest.Mock).mockResolvedValueOnce(false);
    await expect(
      tools().deleteMailRule(user, { mailbox_id: 'mb-1', rule_id: 'missing' }),
    ).resolves.toEqual({ ok: false, reason: 'rule not found in this mailbox' });
  });
});
