import { EmailService } from './email.service';
import type { ThreadView } from './email.types';

/**
 * Unified-inbox fan-out hardening (webmail wave, ~10 mailboxes). Exercises
 * EmailService.listAggregateInbox with listMailboxInbox mocked (the per-mailbox
 * "port") — proving: bounded concurrency, partial-result merge when a mailbox
 * fails, deterministic newest-first ordering, and q/offset fan-out to every
 * mailbox with `limit` applied AFTER the merge.
 *
 * The per-mailbox TIMEOUT mechanism itself is unit-tested in
 * common/async/concurrency.spec.ts (withTimeout rejects slow work); the service
 * wraps each read in withTimeout(8s), so a wedged provider becomes the SAME
 * rejected/omitted slot proven here for the error case.
 */
describe('EmailService.listAggregateInbox — bounded multi-mailbox fan-out', () => {
  const WS = 'ws-1';
  const UID = 'uc-1';

  function makeMailboxes(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `mb-${i}`,
      emailAddress: `user${i}@example.com`,
    }));
  }

  function makeService(mailboxes: unknown[]) {
    const tx = { mailboxAccount: { findMany: jest.fn().mockResolvedValue(mailboxes) } };
    const prisma = {
      withWorkspace: jest.fn((_w: string, _u: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as ConstructorParameters<typeof EmailService>[0];
    const svc = new EmailService(prisma, {} as never, {} as never, {} as never);
    // Everyone may act through every mailbox (the per-user fence is tested elsewhere).
    jest.spyOn(svc as unknown as { mayActThroughMailbox: () => Promise<boolean> }, 'mayActThroughMailbox').mockResolvedValue(true);
    return svc;
  }

  function thread(id: string, iso: string | null): ThreadView {
    return {
      id,
      subject: id,
      message_count: 1,
      unread: false,
      last_message_at: iso,
      last_snippet: null,
      participants: [],
    };
  }

  it('merges partial results across N=10 mailboxes, omits a failing one, bounded + sorted', async () => {
    const svc = makeService(makeMailboxes(10));
    let inFlight = 0;
    let peak = 0;
    jest.spyOn(svc, 'listMailboxInbox').mockImplementation(async (_w, _u, mailboxId) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const idx = Number(String(mailboxId).split('-')[1]);
      if (idx === 3) throw new Error('provider 3 down'); // one erroring mailbox
      return [thread(`t-${idx}`, `2026-07-0${(idx % 9) + 1}T00:00:00.000Z`)];
    });

    const out = await svc.listAggregateInbox(WS, UID, 'inbox', 50, null, 0);

    // 9 of 10 succeeded (mb-3 omitted) — partial results, never a throw.
    expect(out).toHaveLength(9);
    expect(out.find((t) => t.id === 't-3')).toBeUndefined();
    // Bounded concurrency: never more than the cap in flight, but it DID overlap.
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
    // Deterministic newest-first.
    const times = out.map((t) => Date.parse(t.last_message_at as string));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Every merged thread carries its mailbox provenance.
    out.forEach((t) => {
      expect(t.mailbox_id).toBeTruthy();
      expect(t.mailbox_address).toContain('@');
    });
  });

  it('breaks equal-timestamp ties deterministically (stable across mailboxes)', async () => {
    const svc = makeService(makeMailboxes(10));
    jest.spyOn(svc, 'listMailboxInbox').mockImplementation(async (_w, _u, mailboxId) => {
      const idx = Number(String(mailboxId).split('-')[1]);
      // Identical timestamp for all → the tiebreak (mailbox_address, id) decides.
      return [thread(`t-${idx}`, '2026-07-06T00:00:00.000Z')];
    });
    const a = await svc.listAggregateInbox(WS, UID, 'inbox', 50, null, 0);
    const b = await svc.listAggregateInbox(WS, UID, 'inbox', 50, null, 0);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id)); // same order every run
  });

  it('forwards q + offset to EVERY mailbox and applies limit AFTER the merge', async () => {
    const svc = makeService(makeMailboxes(10));
    const seen: Array<{ q: unknown; offset: unknown }> = [];
    jest
      .spyOn(svc, 'listMailboxInbox')
      .mockImplementation(async (_w, _u, mailboxId, _limit, _folder, q, offset) => {
        seen.push({ q, offset });
        const idx = Number(String(mailboxId).split('-')[1]);
        return [thread(`t-${idx}`, `2026-07-06T00:00:0${idx % 10}.000Z`)];
      });

    const out = await svc.listAggregateInbox(WS, UID, 'inbox', 3, 'invoice', 20);

    expect(seen).toHaveLength(10);
    expect(seen.every((s) => s.q === 'invoice' && s.offset === 20)).toBe(true);
    expect(out).toHaveLength(3); // limit applied post-merge
  });
});
