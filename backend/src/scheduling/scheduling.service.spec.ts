import { ScheduledSendState, SnoozedThreadState } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { SchedulingService } from './scheduling.service';
import { SchedulingWorker } from './scheduling.worker';

describe('SchedulingService', () => {
  const WS = 'ws-1';
  const UC = 'uc-1';
  const user = { id: 'local-1', keycloakId: UC, __ucUid: UC };
  const mailbox = {
    id: 'mb-1',
    workspaceId: WS,
    emailAddress: 'founder@acme.test',
    displayName: 'Founder',
    provider: 'stalwart',
    ownerKind: 'SHARED',
    ownerKey: null,
    active: true,
  };

  function snoozed(overrides: Record<string, unknown> = {}) {
    return {
      id: 'snz-1',
      workspaceId: WS,
      mailboxId: 'mb-1',
      threadId: 'thr-1',
      snoozeUntil: new Date('2026-07-18T10:00:00.000Z'),
      subject: 'Weekly digest',
      createdBy: UC,
      state: SnoozedThreadState.ACTIVE,
      createdAt: new Date('2026-07-17T10:00:00.000Z'),
      ...overrides,
    };
  }

  function scheduled(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sch-1',
      workspaceId: WS,
      mailboxId: 'mb-1',
      payload: { toAddress: 'you@acme.test', subject: 'Later', body: 'Body' },
      sendAt: new Date('2026-07-18T10:00:00.000Z'),
      state: ScheduledSendState.PENDING,
      createdBy: UC,
      createdAt: new Date('2026-07-17T10:00:00.000Z'),
      sentAt: null,
      ...overrides,
    };
  }

  function make(opts: {
    tx?: Record<string, unknown>;
    systemClient?: Record<string, unknown>;
    configured?: boolean;
    handles?: boolean;
    move?: boolean;
    composeStatus?: string;
    threadDetail?: { subject: string | null }[];
  } = {}) {
    const tx = opts.tx ?? {
      mailboxAccount: { findFirst: jest.fn().mockResolvedValue(mailbox) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      snoozedThread: {
        create: jest.fn().mockResolvedValue(snoozed()),
        findFirst: jest.fn().mockResolvedValue(snoozed()),
        findMany: jest.fn().mockResolvedValue([snoozed()]),
        update: jest.fn().mockResolvedValue(snoozed({ state: SnoozedThreadState.CANCELLED })),
      },
      scheduledSend: {
        create: jest.fn().mockResolvedValue(scheduled()),
        findMany: jest.fn().mockResolvedValue([scheduled()]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const systemClient = opts.systemClient ?? {
      snoozedThread: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      scheduledSend: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      mailboxAccount: {
        findFirst: jest.fn().mockResolvedValue({ emailAddress: mailbox.emailAddress }),
      },
    };
    const prisma = {
      systemClient,
      withWorkspace: jest.fn((_workspaceId: string, _ucUid: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const stalwart = {
      isConfigured: jest.fn().mockReturnValue(opts.configured ?? true),
      moveThreadToFolder: jest.fn().mockResolvedValue(opts.move ?? true),
      getThreadDetail: jest.fn().mockResolvedValue(opts.threadDetail ?? [{ subject: 'Engine subject' }]),
    } as unknown as StalwartPort;
    const mailProvider = {
      handles: jest.fn().mockReturnValue(opts.handles ?? false),
    } as unknown as MailProviderPort;
    const email = {
      composeEmail: jest.fn().mockResolvedValue({
        id: 'msg-1',
        status: opts.composeStatus ?? 'sent',
        mode: 'send',
        thread_id: 'thr-new',
        external_source: 'email-ops-client',
        external_ref: 'scheduled-send:sch-1',
        created_at: new Date().toISOString(),
      }),
    } as unknown as EmailService;
    const service = new SchedulingService(prisma, stalwart, mailProvider, email);
    return { service, prisma, tx: tx as any, systemClient: systemClient as any, stalwart: stalwart as any, email: email as any };
  }

  it('snoozes a sovereign thread by moving it out of Inbox and recording state', async () => {
    const { service, tx, stalwart } = make();
    const out = await service.snoozeThread(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      threadId: 'thr-1',
      until: new Date('2026-07-18T10:00:00.000Z'),
    });

    expect(stalwart.moveThreadToFolder).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'archive');
    expect(tx.snoozedThread.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ workspaceId: WS, mailboxId: 'mb-1', threadId: 'thr-1', createdBy: UC }),
    }));
    expect(out.snoozed).toBe(true);
    expect(out.item?.state).toBe('active');
  });

  it('unsnoozes by restoring the thread to Inbox and cancelling the active row', async () => {
    const { service, tx, stalwart } = make();
    const out = await service.unsnooze(user, WS, 'snz-1');

    expect(stalwart.moveThreadToFolder).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'inbox');
    expect(tx.snoozedThread.update).toHaveBeenCalledWith({
      where: { id: 'snz-1' },
      data: { state: SnoozedThreadState.CANCELLED },
    });
    expect(out).toEqual({ unsnoozed: true });
  });

  it('lists active snoozed threads for one sovereign mailbox', async () => {
    const { service, tx } = make();
    const out = await service.listSnoozed(user, WS, 'mb-1');

    expect(tx.snoozedThread.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: WS, mailboxId: 'mb-1', state: SnoozedThreadState.ACTIVE },
      orderBy: { snoozeUntil: 'asc' },
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'snz-1', thread_id: 'thr-1', subject: 'Weekly digest' });
  });

  it('captures the caller-supplied subject on the snooze row (no engine lookup)', async () => {
    const { service, tx, stalwart } = make();
    await service.snoozeThread(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      threadId: 'thr-1',
      until: new Date('2026-07-18T10:00:00.000Z'),
      subject: '  Quarterly board deck  ',
    });
    // The reader had the subject in hand — no need to hit the engine for it.
    expect(stalwart.getThreadDetail).not.toHaveBeenCalled();
    expect(tx.snoozedThread.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subject: 'Quarterly board deck' }), // trimmed
    }));
  });

  it('resolves the subject from the engine when the caller omits it (agent path)', async () => {
    const { service, tx, stalwart } = make({
      threadDetail: [{ subject: 'Older' }, { subject: 'Most recent' }],
    });
    await service.snoozeThread(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      threadId: 'thr-1',
      until: new Date('2026-07-18T10:00:00.000Z'),
    });
    expect(stalwart.getThreadDetail).toHaveBeenCalledWith('founder@acme.test', 'thr-1');
    // The most recent non-empty subject wins (matches what the reader shows).
    expect(tx.snoozedThread.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subject: 'Most recent' }),
    }));
  });

  it('stores a null subject when the engine lookup degrades (never throws)', async () => {
    const { service, tx, stalwart } = make();
    (stalwart.getThreadDetail as jest.Mock).mockRejectedValue(new Error('engine down'));
    const out = await service.snoozeThread(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      threadId: 'thr-1',
      until: new Date('2026-07-18T10:00:00.000Z'),
    });
    expect(out.snoozed).toBe(true); // the snooze still succeeds; only the label degrades
    expect(tx.snoozedThread.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ subject: null }),
    }));
  });

  it('refuses external mailboxes cleanly without creating snooze state', async () => {
    const { service, tx, stalwart } = make({ handles: true });
    const out = await service.snoozeThread(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      threadId: 'thr-1',
      until: new Date('2026-07-18T10:00:00.000Z'),
    });

    expect(out).toEqual({ snoozed: false, item: null });
    expect(stalwart.moveThreadToFolder).not.toHaveBeenCalled();
    expect(tx.snoozedThread.create).not.toHaveBeenCalled();
  });

  it('schedules a send for a sovereign mailbox', async () => {
    const { service, tx } = make();
    const out = await service.scheduleSend(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      sendAt: new Date('2026-07-18T10:00:00.000Z'),
      payload: { toAddress: 'you@acme.test', subject: 'Later', body: 'Body' },
    });

    expect(tx.scheduledSend.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        workspaceId: WS,
        mailboxId: 'mb-1',
        payload: expect.objectContaining({ toAddress: 'you@acme.test' }),
      }),
    }));
    expect(out.scheduled).toBe(true);
    expect(out.item?.state).toBe('pending');
  });

  it('getScheduledSend returns a terminal row the pending list hides (undo-bar verdict)', async () => {
    const tx = {
      mailboxAccount: { findFirst: jest.fn().mockResolvedValue(mailbox) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      scheduledSend: {
        findFirst: jest.fn().mockResolvedValue(
          scheduled({ state: ScheduledSendState.SENT, sentAt: new Date('2026-07-18T10:00:30.000Z') }),
        ),
      },
    };
    const { service } = make({ tx });
    const view = await service.getScheduledSend(user, WS, 'mb-1', 'sch-1');
    expect(view?.state).toBe('sent');
    // The fence: scoped by id AND workspace AND mailbox — a foreign id nulls out.
    expect(tx.scheduledSend.findFirst).toHaveBeenCalledWith({
      where: { id: 'sch-1', workspaceId: WS, mailboxId: 'mb-1' },
    });
  });

  it('getScheduledSend degrades to null when the engine is dormant (no DB read)', async () => {
    const tx = {
      mailboxAccount: { findFirst: jest.fn().mockResolvedValue(mailbox) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      scheduledSend: { findFirst: jest.fn() },
    };
    const { service } = make({ tx, configured: false });
    const view = await service.getScheduledSend(user, WS, 'mb-1', 'sch-1');
    expect(view).toBeNull();
    expect(tx.scheduledSend.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an invalid snooze `until` BEFORE archiving the thread (no stranding)', async () => {
    const { service, tx, stalwart } = make();
    const out = await service.snoozeThread(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      threadId: 'thr-1',
      until: new Date('not-a-date'), // Invalid Date, as an LLM might emit
    });
    expect(out).toEqual({ snoozed: false, item: null });
    // Critical: the thread must NOT have been archived (else it strands out of Inbox).
    expect(stalwart.moveThreadToFolder).not.toHaveBeenCalled();
    expect(tx.snoozedThread.create).not.toHaveBeenCalled();
  });

  it('refuses an invalid scheduled-send sendAt without writing', async () => {
    const { service, tx } = make();
    const out = await service.scheduleSend(user, {
      workspaceId: WS,
      mailboxId: 'mb-1',
      sendAt: new Date('whenever'),
      payload: { toAddress: 'you@acme.test', subject: 'x', body: 'y' },
    });
    expect(out).toEqual({ scheduled: false, item: null });
    expect(tx.scheduledSend.create).not.toHaveBeenCalled();
  });

  it('fires a scheduled send with claim-then-send idempotency', async () => {
    const row = scheduled();
    const systemClient = {
      scheduledSend: {
        findMany: jest.fn().mockResolvedValue([row]),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      snoozedThread: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      mailboxAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'mb-1' }) },
    };
    const { service, email } = make({ systemClient });

    const first = await service.fireDueScheduledSends(new Date('2026-07-18T10:00:00.000Z'));
    const second = await service.fireDueScheduledSends(new Date('2026-07-18T10:00:00.000Z'));

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(email.composeEmail).toHaveBeenCalledTimes(1);
    expect(email.composeEmail).toHaveBeenCalledWith(WS, UC, expect.objectContaining({
      mode: 'send',
      externalSource: 'email-ops-client',
      externalRef: 'scheduled-send:sch-1',
      fromMailboxAccountId: 'mb-1',
    }));
  });

  it('wakes a snoozed thread by restoring it to Inbox', async () => {
    const row = snoozed();
    const systemClient = {
      snoozedThread: {
        findMany: jest.fn().mockResolvedValue([row]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      scheduledSend: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      mailboxAccount: {
        findFirst: jest.fn().mockResolvedValue({ emailAddress: 'founder@acme.test' }),
      },
    };
    const { service, stalwart } = make({ systemClient });

    const out = await service.surfaceDueSnoozes(new Date('2026-07-18T10:00:00.000Z'));

    expect(out).toBe(1);
    expect(stalwart.moveThreadToFolder).toHaveBeenCalledWith('founder@acme.test', 'thr-1', 'inbox');
  });

  it('reclaims a stale CLAIMED scheduled send and retries it (crash recovery)', async () => {
    const claimedAt = new Date('2026-07-18T09:50:00.000Z'); // 10 min before "now" — past the TTL
    const stale = scheduled({ state: ScheduledSendState.CLAIMED, claimedAt });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 }); // reclaim + mark-sent
    const systemClient = {
      scheduledSend: {
        findMany: jest.fn().mockResolvedValue([stale]),
        updateMany,
      },
      snoozedThread: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      mailboxAccount: { findFirst: jest.fn().mockResolvedValue({ id: 'mb-1' }) },
    };
    const { service, email } = make({ systemClient });

    const sent = await service.fireDueScheduledSends(new Date('2026-07-18T10:00:00.000Z'));

    expect(sent).toBe(1);
    // The sweep must look for stale CLAIMED rows, not just PENDING.
    expect(systemClient.scheduledSend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ state: ScheduledSendState.CLAIMED }),
          ]),
        }),
      }),
    );
    // Reclaim guards on the exact prior claimedAt so only one worker wins the race.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: ScheduledSendState.CLAIMED,
          claimedAt,
        }),
        data: expect.objectContaining({ state: ScheduledSendState.CLAIMED }),
      }),
    );
    expect(email.composeEmail).toHaveBeenCalledTimes(1);
  });

  it('cancelScheduledSend refuses a caller who cannot act through a HUMAN mailbox', async () => {
    const cancelUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      mailboxAccount: {
        findFirst: jest.fn().mockResolvedValue({ ...mailbox, ownerKind: 'HUMAN', ownerKey: 'someone-else' }),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      scheduledSend: {
        findFirst: jest.fn().mockResolvedValue(scheduled()),
        updateMany: cancelUpdate,
      },
    };
    const { service } = make({ tx });

    const out = await service.cancelScheduledSend(user, WS, 'sch-1');

    expect(out).toEqual({ cancelled: false });
    expect(cancelUpdate).not.toHaveBeenCalled(); // owner gate blocks before the write
  });

  it('worker runOnce is reentrant-safe', async () => {
    let release!: () => void;
    const service = {
      surfaceDueSnoozes: jest.fn(() => new Promise<number>((resolve) => {
        release = () => resolve(1);
      })),
      fireDueScheduledSends: jest.fn().mockResolvedValue(1),
    };
    const worker = new SchedulingWorker(service as unknown as SchedulingService);

    const first = worker.runOnce();
    const second = await worker.runOnce();
    release();
    const firstOut = await first;

    expect(second).toEqual({ snoozes: 0, scheduledSends: 0 });
    expect(firstOut).toEqual({ snoozes: 1, scheduledSends: 1 });
    expect(service.surfaceDueSnoozes).toHaveBeenCalledTimes(1);
  });
});
