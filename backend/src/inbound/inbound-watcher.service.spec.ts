import { InboundWatcherService } from './inbound-watcher.service';

/**
 * Pure-unit coverage (no DB): flag-gating, per-message classify, cursor advance
 * (incl. baseline), degrade-clean, and per-mailbox isolation of failures.
 */
describe('InboundWatcherService', () => {
  function make(opts: {
    mailboxes: any[];
    poll: (mb: string, since: string | null) => any;
    rules?: any[];
    rulesFindMany?: jest.Mock;
    applyInbound?: jest.Mock;
    draftReplyForInbound?: jest.Mock;
  }) {
    const classifyInbound = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const findMany = jest.fn().mockResolvedValue(opts.mailboxes);
    const rulesFindMany = opts.rulesFindMany ?? jest.fn().mockResolvedValue(opts.rules ?? []);
    const applyInbound = opts.applyInbound ?? jest.fn().mockResolvedValue({ matched: 0, applied: 0 });
    const draftReplyForInbound = opts.draftReplyForInbound ?? jest.fn().mockResolvedValue(null);
    const prisma = {
      systemClient: { mailboxAccount: { findMany }, mailRule: { findMany: rulesFindMany } },
      withWorkspace: jest.fn((_ws: string, _uc: string, cb: any) => cb({ mailboxAccount: { update } })),
    };
    const stalwart = { pollInbound: jest.fn(opts.poll) };
    const svc = new InboundWatcherService(
      prisma as any,
      stalwart as any,
      { classifyInbound } as any,
      { applyInbound } as any,
      { draftReplyForInbound } as any,
    );
    return { svc, classifyInbound, update, findMany, stalwart, rulesFindMany, applyInbound, draftReplyForInbound };
  }

  afterEach(() => delete process.env.INBOUND_WATCHER_ENABLED);

  it('classifies each new message and advances the cursor to the high-water mark', async () => {
    const { svc, classifyInbound, update } = make({
      mailboxes: [
        { id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: '2026-01-01T00:00:00Z', ownerKind: 'SHARED' },
      ],
      poll: async () => ({
        cursor: '2026-02-01T00:00:00Z',
        newMessages: [
          { threadId: 't1', fromAddress: 'p@q.test', subject: 'hi', receivedAt: '2026-01-15T00:00:00Z' },
          { threadId: 't2', fromAddress: null, subject: null, receivedAt: '2026-02-01T00:00:00Z' },
        ],
      }),
    });
    expect(await svc.runSweep()).toBe(2);
    expect(classifyInbound).toHaveBeenCalledTimes(2);
    expect(classifyInbound).toHaveBeenCalledWith('ws1', 'inbound-watcher', {
      threadId: 't1',
      fromAddress: 'p@q.test',
      subject: 'hi',
    });
    expect(update).toHaveBeenCalledWith({ where: { id: 'mb1' }, data: { inboundCursor: '2026-02-01T00:00:00Z' } });
  });

  it('baselines a fresh mailbox: advances the cursor, classifies nothing', async () => {
    const { svc, classifyInbound, update } = make({
      mailboxes: [{ id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: null, ownerKind: 'SHARED' }],
      poll: async () => ({ cursor: '2026-02-01T00:00:00Z', newMessages: [] }),
    });
    expect(await svc.runSweep()).toBe(0);
    expect(classifyInbound).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: 'mb1' }, data: { inboundCursor: '2026-02-01T00:00:00Z' } });
  });

  it('still classifies mail delivered to an AGENT mailbox (reply-routing seam)', async () => {
    const { svc, classifyInbound } = make({
      mailboxes: [{ id: 'mba', workspaceId: 'ws1', emailAddress: 'agent@x.test', inboundCursor: 'c', ownerKind: 'AGENT' }],
      poll: async () => ({
        cursor: 'd',
        newMessages: [{ threadId: 'ta', fromAddress: 'human@x.test', subject: 'help', receivedAt: 'd' }],
      }),
    });
    expect(await svc.runSweep()).toBe(1);
    expect(classifyInbound).toHaveBeenCalledWith('ws1', 'inbound-watcher', {
      threadId: 'ta',
      fromAddress: 'human@x.test',
      subject: 'help',
    });
  });

  // ------------------------------------------------- agent-reply runtime wiring

  it('hands an AGENT-mailbox message to the agent-reply runtime (fire-and-forget)', async () => {
    const { svc, draftReplyForInbound } = make({
      mailboxes: [{ id: 'mba', workspaceId: 'ws1', emailAddress: 'agent@x.test', inboundCursor: 'c', ownerKind: 'AGENT' }],
      poll: async () => ({
        cursor: 'd',
        newMessages: [{ threadId: 'ta', fromAddress: 'human@x.test', subject: 'help', receivedAt: 'd' }],
      }),
    });
    expect(await svc.runSweep()).toBe(1);
    expect(draftReplyForInbound).toHaveBeenCalledWith(
      'ws1',
      { id: 'mba', emailAddress: 'agent@x.test', workspaceId: 'ws1' },
      expect.objectContaining({ threadId: 'ta', fromAddress: 'human@x.test', subject: 'help' }),
    );
  });

  it('does NOT invoke the agent-reply runtime for non-AGENT mailboxes', async () => {
    const { svc, draftReplyForInbound } = make({
      mailboxes: [{ id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: 'c', ownerKind: 'SHARED' }],
      poll: async () => ({
        cursor: 'd',
        newMessages: [{ threadId: 't1', fromAddress: 'p@q.test', subject: 'hi', receivedAt: 'd' }],
      }),
    });
    expect(await svc.runSweep()).toBe(1);
    expect(draftReplyForInbound).not.toHaveBeenCalled();
  });

  it('an agent-reply failure is swallowed: triage + the cursor advance are never blocked', async () => {
    const { svc, classifyInbound, update } = make({
      mailboxes: [{ id: 'mba', workspaceId: 'ws1', emailAddress: 'agent@x.test', inboundCursor: 'c', ownerKind: 'AGENT' }],
      draftReplyForInbound: jest.fn().mockRejectedValue(new Error('llm exploded')),
      poll: async () => ({
        cursor: '2026-06-01T00:00:00Z',
        newMessages: [{ threadId: 'ta', fromAddress: 'human@x.test', subject: 'help', receivedAt: 'd' }],
      }),
    });
    expect(await svc.runSweep()).toBe(1);
    expect(classifyInbound).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mba' },
      data: { inboundCursor: '2026-06-01T00:00:00Z' },
    });
  });

  it('degrade-clean: a null poll classifies nothing and leaves the cursor untouched', async () => {
    const { svc, classifyInbound, update } = make({
      mailboxes: [{ id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: 'c', ownerKind: 'SHARED' }],
      poll: async () => null,
    });
    await svc.runSweep();
    expect(classifyInbound).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('one failing mailbox does not fail the whole sweep', async () => {
    const classifyInbound = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      systemClient: {
        mailboxAccount: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'mb1', workspaceId: 'ws1', emailAddress: 'bad@x.test', inboundCursor: 'c', ownerKind: 'SHARED' },
            { id: 'mb2', workspaceId: 'ws2', emailAddress: 'ok@x.test', inboundCursor: 'c', ownerKind: 'SHARED' },
          ]),
        },
        mailRule: { findMany: jest.fn().mockResolvedValue([]) },
      },
      withWorkspace: jest.fn((_ws: string, _uc: string, cb: any) => cb({ mailboxAccount: { update } })),
    };
    const stalwart = {
      pollInbound: jest
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({
          cursor: '2026-03-01T00:00:00Z',
          newMessages: [{ threadId: 't9', fromAddress: 'z@z.test', subject: 's', receivedAt: '2026-03-01T00:00:00Z' }],
        }),
    };
    const svc = new InboundWatcherService(
      prisma as any,
      stalwart as any,
      { classifyInbound } as any,
      { applyInbound: jest.fn() } as any,
      { draftReplyForInbound: jest.fn().mockResolvedValue(null) } as any,
    );
    expect(await svc.runSweep()).toBe(1);
    expect(classifyInbound).toHaveBeenCalledTimes(1);
  });

  it('scheduledSweep is INERT while INBOUND_WATCHER_ENABLED is off', async () => {
    const { svc, findMany } = make({ mailboxes: [], poll: async () => null });
    await svc.scheduledSweep();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('scheduledSweep runs the sweep when the flag is on', async () => {
    process.env.INBOUND_WATCHER_ENABLED = 'true';
    const { svc, findMany } = make({ mailboxes: [], poll: async () => null });
    await svc.scheduledSweep();
    expect(findMany).toHaveBeenCalled();
  });

  // ------------------------------------------------------------- rules wiring

  const ruleRow = {
    id: 'r1',
    workspaceId: 'ws1',
    mailboxId: 'mb1',
    enabled: true,
    priority: 10,
    match: { all: [{ field: 'fromDomain', op: 'equals', value: 'q.test' }] },
    actions: [{ type: 'ARCHIVE' }],
  };

  it('preloads enabled rules ONCE per sweep and applies the mailbox group per new message', async () => {
    const { svc, applyInbound, rulesFindMany } = make({
      mailboxes: [
        { id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: 'c', ownerKind: 'SHARED' },
        { id: 'mb2', workspaceId: 'ws2', emailAddress: 'b@y.test', inboundCursor: 'c', ownerKind: 'SHARED' },
      ],
      rules: [ruleRow],
      poll: async (mb: string) => ({
        cursor: 'd',
        newMessages: [
          { threadId: `t-${mb}`, fromAddress: 'p@q.test', subject: 'hi', receivedAt: 'd' },
        ],
      }),
    });

    expect(await svc.runSweep()).toBe(2);
    // ONE cross-tenant enabled-rules load for the whole sweep (systemClient doctrine).
    expect(rulesFindMany).toHaveBeenCalledTimes(1);
    expect(rulesFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true } }));
    // Applied ONLY for the mailbox that has rules, with the preloaded group passed through.
    expect(applyInbound).toHaveBeenCalledTimes(1);
    expect(applyInbound).toHaveBeenCalledWith(
      'ws1',
      'mb1',
      'a@x.test',
      expect.objectContaining({ threadId: 't-a@x.test', fromAddress: 'p@q.test', subject: 'hi' }),
      [ruleRow],
    );
  });

  it('zero-rules mailboxes do no rules work at all', async () => {
    const { svc, applyInbound, classifyInbound } = make({
      mailboxes: [
        { id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: 'c', ownerKind: 'SHARED' },
      ],
      rules: [],
      poll: async () => ({
        cursor: 'd',
        newMessages: [{ threadId: 't1', fromAddress: 'p@q.test', subject: 'hi', receivedAt: 'd' }],
      }),
    });
    expect(await svc.runSweep()).toBe(1);
    expect(classifyInbound).toHaveBeenCalledTimes(1);
    expect(applyInbound).not.toHaveBeenCalled();
  });

  it('a rules failure never blocks classification or the cursor advance', async () => {
    const { svc, classifyInbound, update } = make({
      mailboxes: [
        { id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: 'c', ownerKind: 'SHARED' },
      ],
      rules: [ruleRow],
      applyInbound: jest.fn().mockRejectedValue(new Error('rules exploded')),
      poll: async () => ({
        cursor: '2026-04-01T00:00:00Z',
        newMessages: [{ threadId: 't1', fromAddress: 'p@q.test', subject: 'hi', receivedAt: 'd' }],
      }),
    });
    expect(await svc.runSweep()).toBe(1);
    expect(classifyInbound).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mb1' },
      data: { inboundCursor: '2026-04-01T00:00:00Z' },
    });
  });

  it('a rules PRELOAD failure degrades clean: the sweep still classifies + advances', async () => {
    const { svc, classifyInbound, update, applyInbound } = make({
      mailboxes: [
        { id: 'mb1', workspaceId: 'ws1', emailAddress: 'a@x.test', inboundCursor: 'c', ownerKind: 'SHARED' },
      ],
      rulesFindMany: jest.fn().mockRejectedValue(new Error('relation "mail_rules" does not exist')),
      poll: async () => ({
        cursor: '2026-05-01T00:00:00Z',
        newMessages: [{ threadId: 't1', fromAddress: 'p@q.test', subject: 'hi', receivedAt: 'd' }],
      }),
    });
    expect(await svc.runSweep()).toBe(1);
    expect(classifyInbound).toHaveBeenCalledTimes(1);
    expect(applyInbound).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mb1' },
      data: { inboundCursor: '2026-05-01T00:00:00Z' },
    });
  });
});
