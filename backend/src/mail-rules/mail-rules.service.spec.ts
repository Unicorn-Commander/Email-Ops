import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { MailRulesService } from './mail-rules.service';

describe('MailRulesService', () => {
  const WS = 'ws-1';
  const UC = 'uc-1';
  const mailbox = {
    id: 'mb-1',
    ownerKind: 'SHARED',
    ownerKey: null,
    provider: 'stalwart',
    active: true,
  };

  function ruleRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rule-1',
      workspaceId: WS,
      mailboxId: 'mb-1',
      name: 'Newsletters to folder',
      enabled: true,
      priority: 10,
      match: { all: [{ field: 'fromDomain', op: 'equals', value: 'news.test' }] },
      actions: [{ type: 'MOVE_TO_FOLDER', value: 'fld-9' }],
      hitCount: 0,
      lastHitAt: null,
      createdBy: UC,
      createdAt: new Date('2026-07-18T10:00:00.000Z'),
      updatedAt: new Date('2026-07-18T10:00:00.000Z'),
      ...overrides,
    };
  }

  function make(opts: {
    tx?: Record<string, unknown>;
    systemClient?: Record<string, unknown>;
  } = {}) {
    const tx = opts.tx ?? {
      mailboxAccount: { findFirst: jest.fn().mockResolvedValue(mailbox) },
      mailRule: {
        findMany: jest.fn().mockResolvedValue([ruleRow()]),
        findFirst: jest.fn().mockResolvedValue(ruleRow()),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _max: { priority: null } }),
        create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
          ruleRow({ ...data }),
        ),
        update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
          ruleRow({ ...data }),
        ),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const systemClient = opts.systemClient ?? {
      mailRule: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      systemClient,
      withWorkspace: jest.fn((_ws: string, _uc: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const stalwart = {
      moveThreadToMailbox: jest.fn().mockResolvedValue(true),
      moveThreadToFolder: jest.fn().mockResolvedValue(true),
      setThreadRead: jest.fn().mockResolvedValue(true),
    } as unknown as StalwartPort;
    const service = new MailRulesService(prisma, stalwart);
    return { service, prisma, tx: tx as any, systemClient: systemClient as any, stalwart: stalwart as any };
  }

  const inboundMsg = { threadId: 'thr-1', fromAddress: 'digest@news.test', subject: 'Weekly digest' };

  // ---------------------------------------------------------------- CRUD

  it('lists rules for one mailbox ordered by priority asc (snake_case views)', async () => {
    const { service, tx } = make();
    const out = await service.list(WS, UC, 'mb-1');

    expect(tx.mailRule.findMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, mailboxId: 'mb-1' },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'rule-1',
      mailbox_id: 'mb-1',
      name: 'Newsletters to folder',
      enabled: true,
      priority: 10,
      hit_count: 0,
      last_hit_at: null,
    });
    expect(out[0].match).toEqual({ all: [{ field: 'fromDomain', op: 'equals', value: 'news.test' }] });
    expect(out[0].actions).toEqual([{ type: 'MOVE_TO_FOLDER', value: 'fld-9' }]);
  });

  it('creates a rule with auto-assigned priority = max + 10 and sanitized JSON', async () => {
    const { service, tx } = make();
    (tx.mailRule.aggregate as jest.Mock).mockResolvedValue({ _max: { priority: 30 } });

    const out = await service.create(WS, UC, 'mb-1', {
      name: '  VIP to top  ',
      match: { any: [{ field: 'from', op: 'equals', value: 'ceo@big.test' }, { bogus: true }] },
      actions: [{ type: 'MARK_READ', junk: 'dropped' }],
    });

    expect(tx.mailRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: WS,
        mailboxId: 'mb-1',
        name: 'VIP to top', // trimmed
        enabled: true,
        priority: 40,
        // The PARSED forms are stored — junk keys and malformed children dropped.
        match: { any: [{ field: 'from', op: 'equals', value: 'ceo@big.test' }] },
        actions: [{ type: 'MARK_READ' }],
        createdBy: UC,
      }),
    });
    expect(out.priority).toBe(40);
  });

  it('assigns priority 10 to the first rule of a mailbox', async () => {
    const { service, tx } = make();
    await service.create(WS, UC, 'mb-1', {
      name: 'First',
      match: { all: [{ field: 'subject', op: 'contains', value: 'invoice' }] },
      actions: [{ type: 'ARCHIVE' }],
    });
    expect(tx.mailRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ priority: 10 }),
    });
  });

  it('rejects an empty match ({} and nested-empty groups)', async () => {
    const { service, tx } = make();
    await expect(
      service.create(WS, UC, 'mb-1', { name: 'x', match: {}, actions: [{ type: 'ARCHIVE' }] }),
    ).rejects.toThrow('match must contain at least one condition');
    await expect(
      service.create(WS, UC, 'mb-1', { name: 'x', match: { all: [{ any: [] }] }, actions: [{ type: 'ARCHIVE' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.mailRule.create).not.toHaveBeenCalled();
  });

  it('accepts an ANY match and a grouped ALL-of-ANYs match, storing the parsed forms', async () => {
    const { service, tx } = make();
    const grouped = {
      all: [
        {
          any: [
            { field: 'fromDomain', op: 'equals', value: 'acme.test' },
            { field: 'fromDomain', op: 'equals', value: 'other.test' },
          ],
        },
        {
          any: [
            { field: 'subject', op: 'contains', value: 'receipt' },
            { field: 'subject', op: 'contains', value: 'invoice' },
          ],
        },
      ],
    };
    await service.create(WS, UC, 'mb-1', { name: 'Grouped', match: grouped, actions: [{ type: 'ARCHIVE' }] });
    expect(tx.mailRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ match: grouped }),
    });

    await service.create(WS, UC, 'mb-1', {
      name: 'Any',
      match: { any: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
      actions: [{ type: 'ARCHIVE' }],
    });
    expect(tx.mailRule.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ match: { any: [{ field: 'from', op: 'equals', value: 'a@b.test' }] } }),
    });
  });

  it('rejects a match node that sets both "all" and "any" (create AND patch)', async () => {
    const { service, tx } = make();
    const both = {
      all: [{ field: 'from', op: 'contains', value: 'a' }],
      any: [{ field: 'subject', op: 'contains', value: 'b' }],
    };
    await expect(
      service.create(WS, UC, 'mb-1', { name: 'x', match: both, actions: [{ type: 'ARCHIVE' }] }),
    ).rejects.toThrow('match node must use either "all" or "any", not both');
    // Same fence on a nested group.
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'x',
        match: { all: [both] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('match node must use either "all" or "any", not both');
    await expect(service.update(WS, UC, 'mb-1', 'rule-1', { match: both })).rejects.toThrow(
      'match node must use either "all" or "any", not both',
    );
    expect(tx.mailRule.create).not.toHaveBeenCalled();
    expect(tx.mailRule.update).not.toHaveBeenCalled();
  });

  it('caps the match tree: ≤5 groups, ≤10 conditions per group / top level', async () => {
    const { service, tx } = make();
    const cond = (value: string) => ({ field: 'subject' as const, op: 'contains' as const, value });
    const group = (value: string) => ({ any: [cond(value)] });

    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'too many groups',
        match: { all: Array.from({ length: 6 }, (_, i) => group(`g${i}`)) },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('match supports at most 5 groups.');

    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'too many top-level conditions',
        match: { all: Array.from({ length: 11 }, (_, i) => cond(`c${i}`)) },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('match supports at most 10 conditions per group.');

    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'too many grouped conditions',
        match: { all: [{ any: Array.from({ length: 11 }, (_, i) => cond(`c${i}`)) }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('match supports at most 10 conditions per group.');

    // At the caps exactly, the rule is accepted.
    await service.create(WS, UC, 'mb-1', {
      name: 'at cap',
      match: { all: Array.from({ length: 5 }, (_, i) => group(`g${i}`)) },
      actions: [{ type: 'ARCHIVE' }],
    });
    expect(tx.mailRule.create).toHaveBeenCalledTimes(1);
  });

  it('rejects group-in-group nesting and empty groups with clear messages', async () => {
    const { service, tx } = make();
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'too deep',
        match: { all: [{ any: [{ all: [{ field: 'from', op: 'contains', value: 'a' }] }] }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('match groups nest one level deep — a group may contain only conditions');

    // An empty group beside a real condition is a rule that can NEVER match
    // (empty ANY matches nothing) — refuse it loudly instead of storing it.
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'dead group',
        match: { all: [{ field: 'from', op: 'contains', value: 'a' }, { any: [] }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('match groups must contain at least one condition');
    expect(tx.mailRule.create).not.toHaveBeenCalled();
  });

  it('rejects LABEL actions (not supported yet)', async () => {
    const { service } = make();
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'x',
        match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
        actions: [{ type: 'LABEL', value: 'red' }, { type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('LABEL is not supported yet');
  });

  it('rejects STOP-only actions (must have at least one effectful action)', async () => {
    const { service } = make();
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'x',
        match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
        actions: [{ type: 'STOP' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an actions array that parses to nothing', async () => {
    const { service } = make();
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'x',
        match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
        actions: [{ type: 'NOT_A_TYPE' }],
      }),
    ).rejects.toThrow('actions must contain at least one valid action');
  });

  it('enforces the 100-rule cap per mailbox', async () => {
    const { service, tx } = make();
    (tx.mailRule.count as jest.Mock).mockResolvedValue(100);
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'over',
        match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.mailRule.create).not.toHaveBeenCalled();
  });

  it('validates an explicit priority (integer within bounds) and a 1..120 name', async () => {
    const { service, tx } = make();
    await service.create(WS, UC, 'mb-1', {
      name: 'ok',
      priority: 5,
      match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
      actions: [{ type: 'ARCHIVE' }],
    });
    expect(tx.mailRule.create).toHaveBeenCalledWith({ data: expect.objectContaining({ priority: 5 }) });

    for (const priority of [1.5, -1, Number.NaN]) {
      await expect(
        service.create(WS, UC, 'mb-1', {
          name: 'bad',
          priority,
          match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
          actions: [{ type: 'ARCHIVE' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: '   ',
        match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow('name must be 1..120 characters.');
  });

  it('refuses CREATE on an external (gmail/microsoft) or inactive mailbox — the watcher never runs rules there', async () => {
    const { service, tx } = make();
    (tx.mailboxAccount.findFirst as jest.Mock).mockResolvedValue({
      ...mailbox,
      provider: 'gmail',
    });
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'Dead rule',
        match: { all: [{ field: 'from', op: 'contains', value: 'x' }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.mailRule.create).not.toHaveBeenCalled();

    (tx.mailboxAccount.findFirst as jest.Mock).mockResolvedValue({ ...mailbox, active: false });
    await expect(
      service.create(WS, UC, 'mb-1', {
        name: 'Dead rule',
        match: { all: [{ field: 'from', op: 'contains', value: 'x' }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('still lists/updates/deletes rules on a later-disconnected mailbox (manageable, not creatable)', async () => {
    const { service, tx } = make();
    (tx.mailboxAccount.findFirst as jest.Mock).mockResolvedValue({
      ...mailbox,
      provider: 'gmail',
    });
    await expect(service.list(WS, UC, 'mb-1')).resolves.toHaveLength(1);
    await expect(service.update(WS, UC, 'mb-1', 'rule-1', { enabled: false })).resolves.not.toBeNull();
    await expect(service.remove(WS, UC, 'mb-1', 'rule-1')).resolves.toBe(true);
  });

  it('treats explicit nulls in a PATCH as not-provided (class-validator lets null through)', async () => {
    const { service, tx } = make();
    const out = await service.update(WS, UC, 'mb-1', 'rule-1', {
      enabled: null,
      name: null,
      match: null,
      actions: null,
      priority: null,
    } as never);
    // Empty effective patch = read-back; a null must never reach Prisma as a
    // null write on a non-nullable column.
    expect(out).not.toBeNull();
    expect(tx.mailRule.update).not.toHaveBeenCalled();
  });

  it('404s when the mailbox is not in this workspace (tenant fence)', async () => {
    const { service, tx } = make();
    (tx.mailboxAccount.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(service.list(WS, UC, 'mb-foreign')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.create(WS, UC, 'mb-foreign', {
        name: 'x',
        match: { all: [{ field: 'from', op: 'equals', value: 'a@b.test' }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.mailRule.create).not.toHaveBeenCalled();
  });

  it('refuses a HUMAN mailbox that belongs to someone else', async () => {
    const { service, tx } = make({
      tx: {
        mailboxAccount: {
          findFirst: jest.fn().mockResolvedValue({ id: 'mb-1', ownerKind: 'HUMAN', ownerKey: 'someone-else' }),
        },
        mailRule: { findMany: jest.fn() },
      },
    });
    await expect(service.list(WS, UC, 'mb-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.mailRule.findMany).not.toHaveBeenCalled();
  });

  it('update validates only the provided fields and patches them', async () => {
    const { service, tx } = make();
    const out = await service.update(WS, UC, 'mb-1', 'rule-1', { enabled: false });

    expect(tx.mailRule.findFirst).toHaveBeenCalledWith({
      where: { id: 'rule-1', workspaceId: WS, mailboxId: 'mb-1' },
    });
    expect(tx.mailRule.update).toHaveBeenCalledWith({
      where: { id: 'rule-1' },
      data: { enabled: false },
    });
    expect(out?.enabled).toBe(false);
  });

  it('update rejects an invalid provided field with the same create-time validation', async () => {
    const { service, tx } = make();
    await expect(service.update(WS, UC, 'mb-1', 'rule-1', { match: {} })).rejects.toThrow(
      'match must contain at least one condition',
    );
    await expect(
      service.update(WS, UC, 'mb-1', 'rule-1', { actions: [{ type: 'LABEL', value: 'x' }] }),
    ).rejects.toThrow('LABEL is not supported yet');
    expect(tx.mailRule.update).not.toHaveBeenCalled();
  });

  it('update returns null when the rule is not in this workspace+mailbox', async () => {
    const { service, tx } = make();
    (tx.mailRule.findFirst as jest.Mock).mockResolvedValue(null);
    const out = await service.update(WS, UC, 'mb-1', 'rule-foreign', { enabled: true });
    expect(out).toBeNull();
    expect(tx.mailRule.update).not.toHaveBeenCalled();
  });

  it('remove is 404-safe: true on delete, false on a miss', async () => {
    const { service, tx } = make();
    expect(await service.remove(WS, UC, 'mb-1', 'rule-1')).toBe(true);
    expect(tx.mailRule.deleteMany).toHaveBeenCalledWith({
      where: { id: 'rule-1', workspaceId: WS, mailboxId: 'mb-1' },
    });
    (tx.mailRule.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    expect(await service.remove(WS, UC, 'mb-1', 'rule-gone')).toBe(false);
  });

  // ---------------------------------------------------------------- applicator

  it('applies a matching rule via the SAME engine primitives the webmail uses', async () => {
    const { service, prisma, tx, stalwart } = make();
    const rules = [
      ruleRow({ actions: [{ type: 'MOVE_TO_FOLDER', value: 'fld-9' }, { type: 'MARK_READ' }] }),
    ];

    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, rules as any);

    // MOVE_TO_FOLDER value is a JMAP folder id → the custom-folder move primitive.
    expect(stalwart.moveThreadToMailbox).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'fld-9');
    expect(stalwart.setThreadRead).toHaveBeenCalledWith('founder@acme.test', 'thr-1', true);
    expect(out).toEqual({ matched: 1, applied: 2 });
    // Hit counters bumped through the fenced write path with the system sub.
    expect(prisma.withWorkspace).toHaveBeenCalledWith(WS, 'mail-rules', expect.any(Function));
    expect(tx.mailRule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['rule-1'] }, workspaceId: WS, mailboxId: 'mb-1' },
      data: { hitCount: { increment: 1 }, lastHitAt: expect.any(Date) },
    });
  });

  it("evaluates 'to' conditions against the message's REAL recipients, never the mailbox address", async () => {
    const { service, stalwart } = make();
    const rules = [
      ruleRow({
        match: { all: [{ field: 'to', op: 'contains', value: 'founder+lists' }] },
        actions: [{ type: 'ARCHIVE' }],
      }),
    ];
    // Real To carries the plus-address — the rule fires.
    const hit = await service.applyInbound(
      WS,
      'mb-1',
      'founder@acme.test',
      { ...inboundMsg, toAddresses: ['founder+lists@acme.test'] },
      rules as any,
    );
    expect(hit.matched).toBe(1);
    expect(stalwart.moveThreadToFolder).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'archive');

    // Unknown To header (empty) — a 'to' rule must NOT fall back to matching
    // the mailbox's own address (the old constant-valued bug).
    const { service: s2, stalwart: sw2 } = make();
    const own = [
      ruleRow({
        match: { all: [{ field: 'to', op: 'equals', value: 'founder@acme.test' }] },
        actions: [{ type: 'TRASH' }],
      }),
    ];
    const miss = await s2.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, own as any);
    expect(miss).toEqual({ matched: 0, applied: 0 });
    expect(sw2.moveThreadToFolder).not.toHaveBeenCalled();
  });

  it('does nothing for a non-matching message (no engine calls, no counters)', async () => {
    const { service, tx, stalwart } = make();
    const out = await service.applyInbound(
      WS,
      'mb-1',
      'founder@acme.test',
      { threadId: 'thr-2', fromAddress: 'friend@other.test', subject: 'hey' },
      [ruleRow()] as any,
    );
    expect(out).toEqual({ matched: 0, applied: 0 });
    expect(stalwart.moveThreadToMailbox).not.toHaveBeenCalled();
    expect(stalwart.moveThreadToFolder).not.toHaveBeenCalled();
    expect(tx.mailRule.updateMany).not.toHaveBeenCalled();
  });

  it('executes actions IN ORDER across rules — the later folder placement wins', async () => {
    const { service, stalwart } = make();
    const rules = [
      ruleRow({ id: 'r-move', priority: 10 }),
      ruleRow({ id: 'r-trash', priority: 20, actions: [{ type: 'TRASH' }] }),
    ];

    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, rules as any);

    expect(out).toEqual({ matched: 2, applied: 2 });
    expect(stalwart.moveThreadToFolder).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'trash');
    const moveOrder = (stalwart.moveThreadToMailbox as jest.Mock).mock.invocationCallOrder[0];
    const trashOrder = (stalwart.moveThreadToFolder as jest.Mock).mock.invocationCallOrder[0];
    expect(moveOrder).toBeLessThan(trashOrder); // priority order; TRASH lands last → wins
  });

  it('maps ARCHIVE to the role-folder move', async () => {
    const { service, stalwart } = make();
    await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, [
      ruleRow({ actions: [{ type: 'ARCHIVE' }] }),
    ] as any);
    expect(stalwart.moveThreadToFolder).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'archive');
  });

  it('a failing action warns and CONTINUES; applyInbound never throws', async () => {
    const { service, stalwart } = make();
    (stalwart.moveThreadToMailbox as jest.Mock).mockRejectedValue(new Error('engine exploded'));
    const rules = [
      ruleRow({ actions: [{ type: 'MOVE_TO_FOLDER', value: 'fld-9' }, { type: 'MARK_READ' }] }),
    ];

    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, rules as any);

    expect(stalwart.setThreadRead).toHaveBeenCalledWith('founder@acme.test', 'thr-1', true); // still ran
    expect(out).toEqual({ matched: 1, applied: 1 });
  });

  it('a dormant engine (port returns false) counts as not-applied, still no throw', async () => {
    const { service, stalwart } = make();
    (stalwart.moveThreadToMailbox as jest.Mock).mockResolvedValue(false);
    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, [ruleRow()] as any);
    expect(out).toEqual({ matched: 1, applied: 0 });
  });

  it('honors STOP: lower-priority rules do not fire and are not counted as hits', async () => {
    const { service, tx, stalwart } = make();
    const rules = [
      ruleRow({ id: 'r-first', priority: 10, actions: [{ type: 'ARCHIVE' }, { type: 'STOP' }] }),
      ruleRow({ id: 'r-late', priority: 20, actions: [{ type: 'MARK_READ' }] }),
    ];

    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, rules as any);

    expect(stalwart.moveThreadToFolder).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'archive');
    expect(stalwart.setThreadRead).not.toHaveBeenCalled();
    expect(out).toEqual({ matched: 1, applied: 1 });
    expect(tx.mailRule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['r-first'] } }) }),
    );
  });

  it('skips LABEL / blank-target moves with a debug log (no crash, not applied)', async () => {
    const { service, stalwart } = make();
    const rules = [
      ruleRow({
        actions: [
          { type: 'LABEL', value: 'red' }, // legacy/foreign row — engine-level skip
          { type: 'MOVE_TO_FOLDER' }, // no folder id → skip
          { type: 'MARK_READ' },
        ],
      }),
    ];
    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, rules as any);
    expect(stalwart.setThreadRead).toHaveBeenCalled();
    expect(stalwart.moveThreadToMailbox).not.toHaveBeenCalled();
    expect(out).toEqual({ matched: 1, applied: 1 });
  });

  it('loads enabled rules itself when no preload is given (scoped by BOTH ids)', async () => {
    const { service, systemClient } = make({
      systemClient: { mailRule: { findMany: jest.fn().mockResolvedValue([ruleRow()]) } },
    });
    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg);
    expect(systemClient.mailRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: WS, mailboxId: 'mb-1', enabled: true } }),
    );
    expect(out.matched).toBe(1);
  });

  it('uses the preloaded rules without re-querying', async () => {
    const { service, systemClient } = make();
    await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, [ruleRow()] as any);
    expect(systemClient.mailRule.findMany).not.toHaveBeenCalled();
  });

  it('ignores preloaded rows for another tenant/mailbox (belt-and-braces fence)', async () => {
    const { service, stalwart } = make();
    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, [
      ruleRow({ mailboxId: 'mb-other' }),
      ruleRow({ id: 'rule-2', workspaceId: 'ws-other' }),
      ruleRow({ id: 'rule-3', enabled: false }),
    ] as any);
    expect(out).toEqual({ matched: 0, applied: 0 });
    expect(stalwart.moveThreadToMailbox).not.toHaveBeenCalled();
  });

  it('catch-all: a rules-load failure returns a zero summary instead of throwing', async () => {
    const { service } = make({
      systemClient: { mailRule: { findMany: jest.fn().mockRejectedValue(new Error('db down')) } },
    });
    await expect(service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg)).resolves.toEqual({
      matched: 0,
      applied: 0,
    });
  });

  it('a hit-counter failure never voids the applied summary', async () => {
    const { service, tx } = make();
    (tx.mailRule.updateMany as jest.Mock).mockRejectedValue(new Error('rls hiccup'));
    const out = await service.applyInbound(WS, 'mb-1', 'founder@acme.test', inboundMsg, [ruleRow()] as any);
    expect(out).toEqual({ matched: 1, applied: 1 });
  });
});
