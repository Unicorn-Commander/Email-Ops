import { AgentAutonomyLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { EmailHealthService } from './email-health.service';

/**
 * EmailHealthService unit tests: the health/setup report over a mocked workspace
 * tx + a fake engine. Covers the overall-status rollup (ok/attention/degraded),
 * the engine + default-mailbox + stale-queue + failed-sends + agents-without-
 * mailbox checks, and the setup counts (autonomous agents).
 */
describe('EmailHealthService', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';
  const UID = 'uc-uid';

  function make(opts: {
    engineConfigured: boolean;
    mailboxes: Array<{ emailAddress: string; isDefault: boolean }>;
    agents: Array<{ autonomyLevel: AgentAutonomyLevel; mailboxAccountId: string | null }>;
    pending: Array<{ createdAt: Date }>;
    failed7d: number;
  }) {
    const tx = {
      mailboxAccount: { findMany: jest.fn().mockResolvedValue(opts.mailboxes) },
      agent: { findMany: jest.fn().mockResolvedValue(opts.agents) },
      agentInboxItem: { findMany: jest.fn().mockResolvedValue(opts.pending) },
      emailMessage: { count: jest.fn().mockResolvedValue(opts.failed7d) },
    };
    const prisma = {
      withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const stalwart = { isConfigured: () => opts.engineConfigured } as unknown as StalwartPort;
    return new EmailHealthService(prisma, stalwart);
  }

  const check = (r: { checks: Array<{ key: string; status: string }> }, key: string) =>
    r.checks.find((c) => c.key === key);

  it('reports OK when the engine is configured, a default mailbox exists, queue empty, no failures', async () => {
    const svc = make({
      engineConfigured: true,
      mailboxes: [{ emailAddress: 'desk@magicunicorn.tech', isDefault: true }],
      agents: [{ autonomyLevel: AgentAutonomyLevel.L1_APPROVE_TO_SEND, mailboxAccountId: 'mb1' }],
      pending: [],
      failed7d: 0,
    });
    const r = await svc.getReport(WS, UID);
    expect(r.status).toBe('ok');
    expect(r.setup).toMatchObject({
      engine_configured: true,
      default_mailbox: 'desk@magicunicorn.tech',
      mailbox_count: 1,
      agent_count: 1,
      autonomous_agents: 0,
    });
    expect(r.queue.pending_approvals).toBe(0);
    expect(check(r, 'engine')?.status).toBe('ok');
    expect(typeof r.generated_at).toBe('string');
  });

  it('reports DEGRADED when the mail engine is not configured', async () => {
    const svc = make({
      engineConfigured: false,
      mailboxes: [{ emailAddress: 'desk@x.dev', isDefault: true }],
      agents: [],
      pending: [],
      failed7d: 0,
    });
    const r = await svc.getReport(WS, UID);
    expect(r.status).toBe('degraded');
    expect(check(r, 'engine')?.status).toBe('fail');
  });

  it('warns (ATTENTION) when the oldest pending approval is stale (> 24h)', async () => {
    const svc = make({
      engineConfigured: true,
      mailboxes: [{ emailAddress: 'desk@x.dev', isDefault: true }],
      agents: [],
      pending: [{ createdAt: new Date(Date.now() - 50 * 3_600_000) }],
      failed7d: 0,
    });
    const r = await svc.getReport(WS, UID);
    expect(r.status).toBe('attention');
    expect(r.queue.pending_approvals).toBe(1);
    expect(r.queue.oldest_pending_age_hours).toBeGreaterThan(24);
    expect(check(r, 'pending_queue')?.status).toBe('warn');
  });

  it('counts L2 (autonomous) agents and warns on agents without a mailbox + recent failures', async () => {
    const svc = make({
      engineConfigured: true,
      mailboxes: [{ emailAddress: 'desk@x.dev', isDefault: true }],
      agents: [
        { autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, mailboxAccountId: null },
        { autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, mailboxAccountId: 'mb1' },
      ],
      pending: [],
      failed7d: 2,
    });
    const r = await svc.getReport(WS, UID);
    expect(r.setup.autonomous_agents).toBe(2);
    expect(check(r, 'agents_without_mailbox')?.status).toBe('warn');
    expect(check(r, 'failed_sends')?.status).toBe('warn');
    expect(r.queue.failed_sends_7d).toBe(2);
    expect(r.status).toBe('attention');
  });

  it('flags a missing default mailbox (warn) when mailboxes exist but none is default', async () => {
    const svc = make({
      engineConfigured: true,
      mailboxes: [{ emailAddress: 'desk@x.dev', isDefault: false }],
      agents: [],
      pending: [],
      failed7d: 0,
    });
    const r = await svc.getReport(WS, UID);
    expect(r.setup.default_mailbox).toBeNull();
    expect(check(r, 'default_mailbox')?.status).toBe('warn');
    expect(r.status).toBe('attention');
  });
});
