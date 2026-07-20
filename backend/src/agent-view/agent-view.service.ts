import { Injectable } from '@nestjs/common';
import { AgentInboxState, MailboxAccessLevel, User } from '@prisma/client';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { EmailService } from '../email/email.service';
import { AgentInboxView, MailboxCountsView, ThreadView } from '../email/email.types';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import {
  AgentMailboxRosterResponse,
  AgentMailboxStats,
  AgentMailboxViewResponse,
  AgentViewAgentSummary,
  AgentViewMailboxSummary,
} from './agent-view.types';

export interface GetAgentMailboxInput {
  workspaceId: string;
  agentId: string;
  threadLimit?: number;
}

type AgentRow = Awaited<ReturnType<WorkspaceTxClient['agent']['findFirst']>>;
type MailboxRow = Awaited<ReturnType<WorkspaceTxClient['mailboxAccount']['findFirst']>>;

@Injectable()
export class AgentViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async getAgentMailbox(
    user: User,
    input: GetAgentMailboxInput,
  ): Promise<AgentMailboxViewResponse | null> {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const limit = clampThreadLimit(input.threadLimit);

    const resolved = await this.prisma.withWorkspace(input.workspaceId, ucUid, async (tx) => {
      const agent = await tx.agent.findFirst({
        where: { id: input.agentId, workspaceId: input.workspaceId },
      });
      if (!agent) return null;

      const mailbox = await this.resolveViewableMailbox(tx, input.workspaceId, agent);

      const counts = await this.countAgentInboxByState(tx, input.workspaceId, agent.key);
      const lastActivityAt = await this.lastActivityAt(tx, input.workspaceId, agent.key, mailbox?.emailAddress ?? null);

      return { agent, mailbox, counts, lastActivityAt };
    });

    if (!resolved) return null;

    const [threads, pendingInbox, mailboxCounts] = await Promise.all([
      resolved.mailbox
        ? this.email.listMailboxInbox(input.workspaceId, ucUid, resolved.mailbox.id, limit, 'inbox')
        : Promise.resolve<ThreadView[]>([]),
      this.email.listAgentInbox(input.workspaceId, ucUid, AgentInboxState.PENDING),
      this.email.getWorkspaceMailCounts(input.workspaceId, ucUid),
    ]);

    const pending = pendingInbox.filter((item) => item.drafted_by === resolved.agent.key);
    const count = this.findMailboxCount(mailboxCounts, resolved.mailbox?.id ?? null);

    return {
      agent: this.agentSummary(resolved.agent, resolved.mailbox),
      threads,
      agentInbox: {
        pending,
        counts: resolved.counts,
      },
      stats: this.stats(count, resolved.lastActivityAt),
    };
  }

  async listAgentMailboxes(
    user: User,
    workspaceId: string,
  ): Promise<AgentMailboxRosterResponse> {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);

    const [roster, mailboxCounts] = await Promise.all([
      this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
        const agents = await tx.agent.findMany({
          where: { workspaceId },
          orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
        });
        if (!agents.length) return [];

        const mailboxIds = agents
          .map((agent) => agent.mailboxAccountId)
          .filter((id): id is string => !!id);
        const mailboxes = mailboxIds.length
          ? await tx.mailboxAccount.findMany({
              where: { id: { in: [...new Set(mailboxIds)] }, workspaceId },
            })
          : [];
        const mailboxById = new Map(mailboxes.map((mailbox) => [mailbox.id, mailbox]));

        const grouped = await tx.agentInboxItem.groupBy({
          by: ['draftedBy'],
          where: {
            workspaceId,
            state: AgentInboxState.PENDING,
            draftedBy: { in: agents.map((agent) => agent.key) },
          },
          _count: { _all: true },
        });
        const pendingByKey = new Map(grouped.map((row) => [row.draftedBy ?? '', row._count._all]));

        return agents.map((agent) => ({
          agent,
          mailbox: agent.mailboxAccountId ? (mailboxById.get(agent.mailboxAccountId) ?? null) : null,
          pending: pendingByKey.get(agent.key) ?? 0,
        }));
      }),
      this.email.getWorkspaceMailCounts(workspaceId, ucUid),
    ]);

    const countsByMailboxId = new Map(mailboxCounts.map((count) => [count.mailbox_id, count]));
    const items = roster.map((row) => {
      const count = row.mailbox ? countsByMailboxId.get(row.mailbox.id) : undefined;
      return {
        agent: this.agentSummary(row.agent, row.mailbox),
        mailbox: {
          address: row.mailbox?.emailAddress ?? null,
          unread: count?.inbox_unread ?? 0,
          pending: row.pending,
        },
      };
    });

    return { items, count: items.length };
  }

  /**
   * The mailbox whose inbox the drill-in shows. Prefer the agent's send identity
   * (mailboxAccountId); fall back to any READ/BOTH binding so a read-only-bound
   * agent (no send identity) still shows its inbox — its card lists that mailbox.
   */
  private async resolveViewableMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agent: NonNullable<AgentRow>,
  ): Promise<MailboxRow> {
    if (agent.mailboxAccountId) {
      const send = await tx.mailboxAccount.findFirst({
        where: { id: agent.mailboxAccountId, workspaceId },
      });
      if (send) return send;
    }
    const binding = await tx.agentMailbox.findFirst({
      where: {
        workspaceId,
        agentId: agent.id,
        access: { in: [MailboxAccessLevel.READ, MailboxAccessLevel.BOTH] },
      },
      // Tie-break on the immutable createdAt (matches agents.service ordering),
      // so which mailbox the drill-in shows is deterministic across edits.
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      include: { mailbox: true },
    });
    return binding?.mailbox ?? null;
  }

  private async countAgentInboxByState(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agentKey: string,
  ): Promise<{ pending: number; approved: number; rejected: number }> {
    const grouped = await tx.agentInboxItem.groupBy({
      by: ['state'],
      where: { workspaceId, draftedBy: agentKey },
      _count: { _all: true },
    });
    const byState = new Map(grouped.map((row) => [row.state, row._count._all]));
    return {
      pending: byState.get(AgentInboxState.PENDING) ?? 0,
      approved: byState.get(AgentInboxState.APPROVED) ?? 0,
      rejected: byState.get(AgentInboxState.REJECTED) ?? 0,
    };
  }

  private async lastActivityAt(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agentKey: string,
    mailboxAddress: string | null,
  ): Promise<string | null> {
    const [inboxItem, message] = await Promise.all([
      tx.agentInboxItem.findFirst({
        where: { workspaceId, draftedBy: agentKey },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true, createdAt: true },
      }),
      mailboxAddress
        ? tx.emailMessage.findFirst({
            where: {
              workspaceId,
              OR: [{ fromAddress: mailboxAddress }, { toAddress: mailboxAddress }],
            },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true, sentAt: true },
          })
        : Promise.resolve(null),
    ]);

    const times = [
      inboxItem?.updatedAt,
      inboxItem?.createdAt,
      message?.sentAt,
      message?.createdAt,
    ].filter((value): value is Date => value instanceof Date);
    if (!times.length) return null;
    return new Date(Math.max(...times.map((value) => value.getTime()))).toISOString();
  }

  private agentSummary(agent: NonNullable<AgentRow>, mailbox: MailboxRow | null): AgentViewAgentSummary {
    return {
      id: agent.id,
      name: agent.displayName,
      handle: agent.key,
      // The stored avatar URL when set; renderers fall back per the one
      // resolution rule (agents/agent-avatar.ts → per-key placeholder → default).
      avatarUrl: agent.avatarUrl ?? undefined,
      mailbox: mailbox ? this.mailboxSummary(mailbox) : null,
    };
  }

  private mailboxSummary(mailbox: NonNullable<MailboxRow>): AgentViewMailboxSummary {
    return {
      id: mailbox.id,
      address: mailbox.emailAddress,
      provider: mailbox.provider,
    };
  }

  private findMailboxCount(counts: MailboxCountsView[], mailboxId: string | null): MailboxCountsView | null {
    if (!mailboxId) return null;
    return counts.find((count) => count.mailbox_id === mailboxId) ?? null;
  }

  private stats(count: MailboxCountsView | null, lastActivityAt: string | null): AgentMailboxStats {
    return {
      unread: count?.inbox_unread,
      total: count?.inbox_total,
      lastActivityAt,
    };
  }
}

function clampThreadLimit(raw?: number): number {
  if (!Number.isFinite(raw)) return 25;
  return Math.min(Math.max(Math.trunc(raw as number), 1), 100);
}
