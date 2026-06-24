/**
 * AgentsService — the agent registry + autonomy dial.
 *
 * The system-of-record for each workspace's registered agents (Customer-Ops,
 * Email-Ops Agent, per-platform personas, ...): the identity behind the "Agents"
 * view, carrying the sending mailbox (a soft reference to MailboxAccount) and the
 * autonomy dial (L0/L1/L2). Like EmailService, every method runs inside
 * `withWorkspace(workspaceId, ucUid, …)` so Postgres RLS scopes every row to the
 * workspace the moment the runtime flips to the NOBYPASSRLS role; we additionally
 * scope reads by `workspaceId` explicitly so a single-row lookup is correct even
 * under the current (pre-flip) owner connection.
 *
 * This layer manages the dial; it does NOT yet enforce it in the compose/approve
 * send path (a deliberate follow-up — so L2 does not auto-send today).
 */

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Agent, AgentAutonomyLevel, AgentInboxState, Prisma } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { AgentView, CreateAgentInput, UpdateAgentInput } from './agents.types';

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The workspace's agents — active first, then alphabetical. */
  async listAgents(workspaceId: string, ucUid: string | null): Promise<AgentView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const agents = await tx.agent.findMany({
        where: { workspaceId },
        orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
      });
      return this.toViews(tx, workspaceId, agents);
    });
  }

  /** One agent by id (scoped to the workspace). Null → 404 at the controller. */
  async getAgent(workspaceId: string, ucUid: string | null, id: string): Promise<AgentView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, workspaceId } });
      return agent ? this.toViewOne(tx, workspaceId, agent) : null;
    });
  }

  /** Register a new agent. 409 on a duplicate key; 400 on a foreign mailbox. */
  async createAgent(
    workspaceId: string,
    ucUid: string | null,
    input: CreateAgentInput,
  ): Promise<AgentView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      if (input.mailboxAccountId) {
        await this.assertMailboxInWorkspace(tx, workspaceId, input.mailboxAccountId);
      }

      const data: Prisma.AgentUncheckedCreateInput = {
        workspaceId,
        key: input.key,
        displayName: input.displayName,
        description: input.description ?? null,
        mailboxAccountId: input.mailboxAccountId ?? null,
        autonomyLevel: input.autonomyLevel ?? AgentAutonomyLevel.L1_APPROVE_TO_SEND,
      };
      if (input.recipientPolicy != null) {
        data.recipientPolicy = input.recipientPolicy as Prisma.InputJsonValue;
      }

      try {
        const created = await tx.agent.create({ data });
        return this.toViewOne(tx, workspaceId, created);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `An agent with key "${input.key}" already exists in this workspace.`,
          );
        }
        throw err;
      }
    });
  }

  /** Patch an agent (partial). Null → 404; explicit null clears a nullable field. */
  async updateAgent(
    workspaceId: string,
    ucUid: string | null,
    id: string,
    patch: UpdateAgentInput,
  ): Promise<AgentView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const existing = await tx.agent.findFirst({ where: { id, workspaceId } });
      if (!existing) return null;

      if (patch.mailboxAccountId) {
        await this.assertMailboxInWorkspace(tx, workspaceId, patch.mailboxAccountId);
      }

      const data: Prisma.AgentUncheckedUpdateInput = {};
      if (patch.displayName !== undefined) data.displayName = patch.displayName;
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.mailboxAccountId !== undefined) data.mailboxAccountId = patch.mailboxAccountId;
      if (patch.autonomyLevel !== undefined) data.autonomyLevel = patch.autonomyLevel;
      if (patch.active !== undefined) data.active = patch.active;
      if (patch.recipientPolicy !== undefined) {
        data.recipientPolicy =
          patch.recipientPolicy === null
            ? Prisma.DbNull
            : (patch.recipientPolicy as Prisma.InputJsonValue);
      }

      const updated = await tx.agent.update({ where: { id: existing.id }, data });
      return this.toViewOne(tx, workspaceId, updated);
    });
  }

  // ── view mapping ────────────────────────────────────────────────────────

  /** Map a batch of agents → views, resolving mailbox addresses + pending counts
   *  in two queries (no N+1). */
  private async toViews(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agents: Agent[],
  ): Promise<AgentView[]> {
    if (agents.length === 0) return [];

    const mailboxIds = [
      ...new Set(agents.map((a) => a.mailboxAccountId).filter((v): v is string => !!v)),
    ];
    const mailboxes = mailboxIds.length
      ? await tx.mailboxAccount.findMany({
          where: { id: { in: mailboxIds }, workspaceId },
          select: { id: true, emailAddress: true },
        })
      : [];
    const addrById = new Map(mailboxes.map((m) => [m.id, m.emailAddress]));

    // Pending drafts per agent, attributed via the legacy free-text draftedBy slug.
    const keys = agents.map((a) => a.key);
    const grouped = await tx.agentInboxItem.groupBy({
      by: ['draftedBy'],
      where: { state: AgentInboxState.PENDING, draftedBy: { in: keys } },
      _count: { _all: true },
    });
    const pendingByKey = new Map(grouped.map((g) => [g.draftedBy ?? '', g._count._all]));

    return agents.map((a) =>
      this.toView(
        a,
        a.mailboxAccountId ? (addrById.get(a.mailboxAccountId) ?? null) : null,
        pendingByKey.get(a.key) ?? 0,
      ),
    );
  }

  /** Map a single agent → view (resolves its mailbox + pending count). */
  private async toViewOne(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agent: Agent,
  ): Promise<AgentView> {
    const mailboxAddress = agent.mailboxAccountId
      ? ((
          await tx.mailboxAccount.findFirst({
            where: { id: agent.mailboxAccountId, workspaceId },
            select: { emailAddress: true },
          })
        )?.emailAddress ?? null)
      : null;
    const pending = await tx.agentInboxItem.count({
      where: { state: AgentInboxState.PENDING, draftedBy: agent.key },
    });
    return this.toView(agent, mailboxAddress, pending);
  }

  private toView(agent: Agent, mailboxAddress: string | null, pendingCount: number): AgentView {
    return {
      id: agent.id,
      key: agent.key,
      display_name: agent.displayName,
      description: agent.description,
      mailbox_account_id: agent.mailboxAccountId,
      mailbox_address: mailboxAddress,
      autonomy_level: agent.autonomyLevel,
      recipient_policy: (agent.recipientPolicy as Record<string, unknown> | null) ?? null,
      active: agent.active,
      pending_count: pendingCount,
      created_at: agent.createdAt?.toISOString() ?? null,
      updated_at: agent.updatedAt?.toISOString() ?? null,
    };
  }

  /** A clear 400 (beats a silent dangling soft-ref) when a mailbox isn't ours. */
  private async assertMailboxInWorkspace(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxAccountId: string,
  ): Promise<void> {
    const mb = await tx.mailboxAccount.findFirst({
      where: { id: mailboxAccountId, workspaceId },
      select: { id: true },
    });
    if (!mb) {
      throw new BadRequestException(
        'mailbox_account_id does not reference a mailbox in this workspace.',
      );
    }
  }
}
