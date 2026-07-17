import { InboundWatcherService } from './inbound-watcher.service';

/**
 * Pure-unit coverage (no DB): flag-gating, per-message classify, cursor advance
 * (incl. baseline), degrade-clean, and per-mailbox isolation of failures.
 */
describe('InboundWatcherService', () => {
  function make(opts: { mailboxes: any[]; poll: (mb: string, since: string | null) => any }) {
    const classifyInbound = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({});
    const findMany = jest.fn().mockResolvedValue(opts.mailboxes);
    const prisma = {
      systemClient: { mailboxAccount: { findMany } },
      withWorkspace: jest.fn((_ws: string, _uc: string, cb: any) => cb({ mailboxAccount: { update } })),
    };
    const stalwart = { pollInbound: jest.fn(opts.poll) };
    const svc = new InboundWatcherService(prisma as any, stalwart as any, { classifyInbound } as any);
    return { svc, classifyInbound, update, findMany, stalwart };
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
    const svc = new InboundWatcherService(prisma as any, stalwart as any, { classifyInbound } as any);
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
});
