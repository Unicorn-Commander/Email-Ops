/**
 * EmailHealthService — the email-steward's "how's email?" report.
 *
 * Workspace-scoped (via withWorkspace, so RLS scopes every read) aggregate of the
 * mail engine config, the deliverable mailboxes, the approval queue (backlog +
 * age), recent send failures, and the registered agent fleet. Pure reads; no
 * mutation. Both the REST endpoint (a human panel) and the MCP tool (a Mail-Ops
 * steward agent) return this same report.
 */

import { Injectable } from '@nestjs/common';
import { AgentAutonomyLevel, AgentInboxState, EmailMessageStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { EmailHealthCheck, EmailHealthReport } from './email-health.types';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_PENDING_HOURS = 24;

@Injectable()
export class EmailHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
  ) {}

  async getReport(workspaceId: string, ucUid: string | null): Promise<EmailHealthReport> {
    const engineConfigured = this.stalwart.isConfigured();
    const since = new Date(Date.now() - SEVEN_DAYS_MS);

    const { mailboxes, agents, pending, failed7d } = await this.prisma.withWorkspace(
      workspaceId,
      ucUid,
      async (tx) => {
        const [mailboxes, agents, pending, failed7d] = await Promise.all([
          tx.mailboxAccount.findMany({
            where: { workspaceId, active: true },
            select: { emailAddress: true, isDefault: true },
          }),
          tx.agent.findMany({
            where: { workspaceId, active: true },
            select: { autonomyLevel: true, mailboxAccountId: true },
          }),
          tx.agentInboxItem.findMany({
            where: { workspaceId, state: AgentInboxState.PENDING },
            select: { createdAt: true },
            orderBy: { createdAt: 'asc' },
          }),
          tx.emailMessage.count({
            where: { workspaceId, status: EmailMessageStatus.FAILED, createdAt: { gte: since } },
          }),
        ]);
        return { mailboxes, agents, pending, failed7d };
      },
    );

    const defaultMailbox = mailboxes.find((m) => m.isDefault)?.emailAddress ?? null;
    const autonomousAgents = agents.filter(
      (a) => a.autonomyLevel === AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT,
    ).length;
    const agentsWithoutMailbox = agents.filter((a) => !a.mailboxAccountId).length;
    const oldestPendingAgeHours = pending.length
      ? Math.round(((Date.now() - pending[0].createdAt.getTime()) / 3_600_000) * 10) / 10
      : null;

    const checks: EmailHealthCheck[] = [];

    checks.push(
      engineConfigured
        ? { key: 'engine', label: 'Mail engine', status: 'ok', detail: 'Configured — sends route to the engine.' }
        : {
            key: 'engine',
            label: 'Mail engine',
            status: 'fail',
            detail: 'Not configured — sends record FAILED (degrade-clean) until the engine is wired.',
          },
    );

    if (defaultMailbox) {
      checks.push({
        key: 'default_mailbox',
        label: 'Default mailbox',
        status: 'ok',
        detail: `Outbound mail is sent as ${defaultMailbox}.`,
      });
    } else {
      checks.push({
        key: 'default_mailbox',
        label: 'Default mailbox',
        status: mailboxes.length ? 'warn' : 'fail',
        detail: mailboxes.length
          ? 'No mailbox is flagged default — the From identity is ambiguous.'
          : 'No mailbox accounts configured — nothing can send.',
      });
    }

    if (pending.length === 0) {
      checks.push({
        key: 'pending_queue',
        label: 'Approval queue',
        status: 'ok',
        detail: 'No drafts awaiting approval.',
      });
    } else {
      const stale = (oldestPendingAgeHours ?? 0) >= STALE_PENDING_HOURS;
      checks.push({
        key: 'pending_queue',
        label: 'Approval queue',
        status: stale ? 'warn' : 'ok',
        detail: `${pending.length} awaiting approval${
          stale ? `, oldest ${formatAge(oldestPendingAgeHours)} old` : ''
        }.`,
      });
    }

    checks.push(
      failed7d === 0
        ? { key: 'failed_sends', label: 'Recent sends', status: 'ok', detail: 'No failed sends in the last 7 days.' }
        : {
            key: 'failed_sends',
            label: 'Recent sends',
            status: 'warn',
            detail: `${failed7d} send${failed7d === 1 ? '' : 's'} FAILED in the last 7 days.`,
          },
    );

    if (agentsWithoutMailbox > 0) {
      checks.push({
        key: 'agents_without_mailbox',
        label: 'Agent mailboxes',
        status: 'warn',
        detail: `${agentsWithoutMailbox} active agent${agentsWithoutMailbox === 1 ? ' has' : 's have'} no mailbox assigned (falls back to the default).`,
      });
    } else if (agents.length > 0) {
      checks.push({
        key: 'agents_without_mailbox',
        label: 'Agent mailboxes',
        status: 'ok',
        detail: 'Every active agent has a sending mailbox.',
      });
    }

    const status: EmailHealthReport['status'] = checks.some((c) => c.status === 'fail')
      ? 'degraded'
      : checks.some((c) => c.status === 'warn')
        ? 'attention'
        : 'ok';

    return {
      status,
      checks,
      setup: {
        engine_configured: engineConfigured,
        default_mailbox: defaultMailbox,
        mailbox_count: mailboxes.length,
        agent_count: agents.length,
        autonomous_agents: autonomousAgents,
      },
      queue: {
        pending_approvals: pending.length,
        oldest_pending_age_hours: oldestPendingAgeHours,
        failed_sends_7d: failed7d,
      },
      generated_at: new Date().toISOString(),
    };
  }
}

function formatAge(hours: number | null): string {
  if (hours == null) return 'n/a';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
