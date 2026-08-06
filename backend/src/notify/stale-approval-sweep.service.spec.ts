import {
  humanAge,
  mergeNotifyStamp,
  readLastReminded,
  StaleApprovalSweepService,
} from './stale-approval-sweep.service';
import { AGENT_INBOX_DEEP_LINK } from './stable-notifier.service';

/**
 * Pure-unit coverage (mocked Prisma + notifier): the due-item filter (never
 * reminded / reminded >24h ago), the grouped digest (header count, oldest age,
 * bullet cap + overflow), the payload MERGE that preserves policy, and the
 * confirm-on-success stamp (a failed post writes no stamp → retried next hour).
 */
describe('StaleApprovalSweepService', () => {
  const NOW = new Date('2026-07-20T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

  function row(over: Partial<any> = {}): any {
    return {
      id: over.id ?? 'i1',
      workspaceId: over.workspaceId ?? 'ws1',
      kind: over.kind ?? 'EMAIL',
      summary: over.summary ?? 'Re: Order → alice@acme.test — held: L1-external-requires-approval',
      draftedBy: over.draftedBy ?? 'perry',
      createdAt: over.createdAt ?? hoursAgo(48),
      payload: over.payload ?? null,
    };
  }

  function makeSweep(opts: {
    rows?: any[];
    notifyText?: jest.Mock;
    dormant?: boolean;
  }) {
    const findMany = jest.fn().mockResolvedValue(opts.rows ?? []);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const withWorkspace = jest.fn((_ws: string, _uc: string | null, cb: any) =>
      cb({ agentInboxItem: { updateMany } }),
    );
    const prisma = { systemClient: { agentInboxItem: { findMany } }, withWorkspace };
    const notifyText = opts.notifyText ?? jest.fn().mockResolvedValue(true);
    const notifier = { isDormant: () => opts.dormant ?? false, notifyText };
    const svc = new StaleApprovalSweepService(prisma as any, notifier as any);
    return { svc, findMany, updateMany, withWorkspace, notifyText };
  }

  describe('pure helpers', () => {
    it('readLastReminded parses payload.notify.lastRemindedAt (null on absence/garbage)', () => {
      expect(readLastReminded(null)).toBeNull();
      expect(readLastReminded({ policy: {} })).toBeNull();
      expect(readLastReminded({ notify: { lastRemindedAt: 'nope' } })).toBeNull();
      const d = readLastReminded({ notify: { lastRemindedAt: '2026-07-20T00:00:00Z' } });
      expect(d?.toISOString()).toBe('2026-07-20T00:00:00.000Z');
    });

    it('mergeNotifyStamp sets lastRemindedAt WITHOUT clobbering policy or other notify keys', () => {
      const merged = mergeNotifyStamp(
        { policy: { decision: 'hold', reasons: [{ code: 'x' }] }, notify: { seenBy: 'u1' }, extra: 7 },
        NOW,
      );
      expect(merged.policy).toEqual({ decision: 'hold', reasons: [{ code: 'x' }] });
      expect(merged.extra).toBe(7);
      expect((merged.notify as any).seenBy).toBe('u1');
      expect((merged.notify as any).lastRemindedAt).toBe(NOW.toISOString());
    });

    it('humanAge picks the coarsest unit', () => {
      expect(humanAge(12 * 86400_000)).toBe('12d');
      expect(humanAge(5 * 3600_000)).toBe('5h');
      expect(humanAge(30 * 60_000)).toBe('30m');
      expect(humanAge(10_000)).toBe('10s');
    });
  });

  describe('runSweep', () => {
    it('groups due items into ONE message (count + oldest age + deep link) and stamps each', async () => {
      const rows = [
        row({ id: 'a', createdAt: hoursAgo(72), summary: 'Re: A' }),
        row({ id: 'b', createdAt: hoursAgo(48), summary: 'Re: B' }),
        row({ id: 'c', workspaceId: 'ws2', createdAt: hoursAgo(30), summary: 'Archive 4 threads', kind: 'CLEANUP' }),
      ];
      const { svc, notifyText, updateMany, withWorkspace } = makeSweep({ rows });
      const reminded = await svc.runSweep(NOW);

      expect(reminded).toBe(3);
      expect(notifyText).toHaveBeenCalledTimes(1);
      const msg = notifyText.mock.calls[0][0] as string;
      expect(msg).toContain('3 approvals waiting, oldest 3d:');
      expect(msg).toContain('• Re: A (3d)');
      expect(msg).toContain('• Archive 4 threads (1d)');
      expect(msg).toContain(AGENT_INBOX_DEEP_LINK);

      // Each due item is stamped, fenced by its own workspace.
      expect(updateMany).toHaveBeenCalledTimes(3);
      expect(withWorkspace).toHaveBeenCalledWith('ws2', 'notify-sweep', expect.any(Function));
      const stamp = updateMany.mock.calls[0][0];
      expect(stamp.where).toMatchObject({ id: 'a', workspaceId: 'ws1', state: 'PENDING' });
      expect((stamp.data.payload as any).notify.lastRemindedAt).toBe(NOW.toISOString());
    });

    it('filters out items reminded <24h ago; keeps never-reminded and >24h-ago', async () => {
      const rows = [
        row({ id: 'fresh', payload: { notify: { lastRemindedAt: hoursAgo(12).toISOString() } } }),
        row({ id: 'stale', payload: { notify: { lastRemindedAt: hoursAgo(30).toISOString() } } }),
        row({ id: 'never', payload: { policy: { decision: 'hold' } } }),
      ];
      const { svc, notifyText, updateMany } = makeSweep({ rows });
      const reminded = await svc.runSweep(NOW);

      expect(reminded).toBe(2);
      const msg = notifyText.mock.calls[0][0] as string;
      expect(msg).toContain('2 approvals waiting');
      const stampedIds = updateMany.mock.calls.map((c) => c[0].where.id);
      expect(stampedIds.sort()).toEqual(['never', 'stale']);
    });

    it('preserves payload.policy when stamping a held item', async () => {
      const rows = [row({ id: 'held', payload: { policy: { decision: 'hold', reasons: [{ code: 'thread-rate-cap' }] } } })];
      const { svc, updateMany } = makeSweep({ rows });
      await svc.runSweep(NOW);
      const payload = updateMany.mock.calls[0][0].data.payload as any;
      expect(payload.policy).toEqual({ decision: 'hold', reasons: [{ code: 'thread-rate-cap' }] });
      expect(payload.notify.lastRemindedAt).toBe(NOW.toISOString());
    });

    it('caps the bullet list at 8 + "…and N more"', async () => {
      const rows = Array.from({ length: 11 }, (_, i) =>
        row({ id: `n${i}`, createdAt: hoursAgo(48 - i), summary: `Item ${i}` }),
      );
      const { svc, notifyText } = makeSweep({ rows });
      await svc.runSweep(NOW);
      const msg = notifyText.mock.calls[0][0] as string;
      const bulletCount = (msg.match(/^• /gm) ?? []).length;
      expect(bulletCount).toBe(9); // 8 items + the overflow line
      expect(msg).toContain('• …and 3 more');
      expect(msg).toContain('11 approvals waiting');
    });

    it('confirm-on-success: a FAILED post writes NO stamp and returns 0 (retried next hour)', async () => {
      const rows = [row({ id: 'a' }), row({ id: 'b' })];
      const notifyText = jest.fn().mockResolvedValue(false);
      const { svc, updateMany } = makeSweep({ rows, notifyText });
      const reminded = await svc.runSweep(NOW);
      expect(reminded).toBe(0);
      expect(updateMany).not.toHaveBeenCalled();
    });

    it('nothing due → no notify, no stamp, returns 0', async () => {
      const { svc, notifyText, updateMany } = makeSweep({ rows: [] });
      expect(await svc.runSweep(NOW)).toBe(0);
      expect(notifyText).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('scheduledSweep gating', () => {
    afterEach(() => delete process.env.EMAIL_OPS_NOTIFY_ENABLED);

    it('does NOTHING while EMAIL_OPS_NOTIFY_ENABLED is off (no scan)', async () => {
      delete process.env.EMAIL_OPS_NOTIFY_ENABLED;
      const { svc, findMany } = makeSweep({ rows: [row()] });
      await svc.scheduledSweep();
      expect(findMany).not.toHaveBeenCalled();
    });

    it('does NOTHING when the notifier is dormant even if enabled', async () => {
      process.env.EMAIL_OPS_NOTIFY_ENABLED = 'true';
      const { svc, findMany } = makeSweep({ rows: [row()], dormant: true });
      await svc.scheduledSweep();
      expect(findMany).not.toHaveBeenCalled();
    });

    it('runs the sweep when enabled AND the notifier is active', async () => {
      process.env.EMAIL_OPS_NOTIFY_ENABLED = 'true';
      const { svc, findMany } = makeSweep({ rows: [] });
      await svc.scheduledSweep();
      expect(findMany).toHaveBeenCalledTimes(1);
    });
  });
});
