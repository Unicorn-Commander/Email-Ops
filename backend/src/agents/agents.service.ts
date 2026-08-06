/**
 * AgentsService — the agent registry (autonomy dial + multi-mailbox + hierarchy).
 *
 * The system-of-record for each workspace's registered agents: identity, the
 * autonomy dial (L0/L1/L2), the mailboxes the agent may act through (the
 * AgentMailbox join — multi-mailbox), and the org-chart hierarchy. Every method
 * runs inside `withWorkspace(workspaceId, ucUid, …)` (RLS chokepoint) and scopes
 * reads by workspaceId explicitly (correct even under the pre-flip owner role).
 *
 * Invariant maintained here: an agent has at most ONE primary binding, and
 * Agent.mailboxAccountId is the denormalized cache of that primary mailbox (the
 * send-identity resolver in EmailService reads the cache). Governance actions are
 * audited into the shared AgentActionEvent log.
 */

import {
  Agent,
  AgentActionKind,
  AgentAutonomyLevel,
  AgentInboxState,
  AgentMailbox,
  MailboxAccessLevel,
  Prisma,
} from '@prisma/client';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import {
  AgentMailboxView,
  AgentView,
  BindMailboxInput,
  CreateAgentInput,
  UpdateAgentInput,
} from './agents.types';

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

  /** How many agents the workspace has (for the policy cap). */
  async countAgents(workspaceId: string, ucUid: string | null): Promise<number> {
    return this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.agent.count({ where: { workspaceId } }),
    );
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
        avatarUrl: input.avatarUrl ?? null,
        autonomyLevel: input.autonomyLevel ?? AgentAutonomyLevel.L1_APPROVE_TO_SEND,
        managerAgentKey: input.managerAgentKey ?? null,
      };
      if (input.tier) data.tier = input.tier;
      if (input.recipientPolicy != null) {
        data.recipientPolicy = input.recipientPolicy as Prisma.InputJsonValue;
      }

      let created: Agent;
      try {
        created = await tx.agent.create({ data });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException(
            `An agent with key "${input.key}" already exists in this workspace.`,
          );
        }
        throw err;
      }

      // The primary mailbox (if any) goes through the canonical binding path so
      // the AgentMailbox row + the mailboxAccountId cache stay in sync.
      if (input.mailboxAccountId) {
        await this.setPrimaryMailbox(tx, workspaceId, created.id, input.mailboxAccountId);
      }
      await this.recordAgentAction(tx, workspaceId, AgentActionKind.AGENT_CREATED, created.key, ucUid, null);

      const fresh = await tx.agent.findFirstOrThrow({ where: { id: created.id } });
      return this.toViewOne(tx, workspaceId, fresh);
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
      if (patch.avatarUrl !== undefined) data.avatarUrl = patch.avatarUrl;
      if (patch.autonomyLevel !== undefined) data.autonomyLevel = patch.autonomyLevel;
      if (patch.tier !== undefined) data.tier = patch.tier;
      if (patch.managerAgentKey !== undefined) data.managerAgentKey = patch.managerAgentKey;
      if (patch.paused !== undefined) data.paused = patch.paused;
      if (patch.active !== undefined) data.active = patch.active;
      if (patch.recipientPolicy !== undefined) {
        data.recipientPolicy =
          patch.recipientPolicy === null
            ? Prisma.DbNull
            : (patch.recipientPolicy as Prisma.InputJsonValue);
      }
      if (Object.keys(data).length > 0) {
        await tx.agent.update({ where: { id: existing.id }, data });
      }

      // Re-point the primary mailbox through the canonical binding path.
      if (patch.mailboxAccountId !== undefined) {
        await this.setPrimaryMailbox(tx, workspaceId, existing.id, patch.mailboxAccountId);
      }

      const auditKind =
        patch.autonomyLevel !== undefined
          ? AgentActionKind.AUTONOMY_CHANGED
          : AgentActionKind.AGENT_UPDATED;
      await this.recordAgentAction(tx, workspaceId, auditKind, existing.key, ucUid, null);

      const updated = await tx.agent.findFirstOrThrow({ where: { id: existing.id } });
      return this.toViewOne(tx, workspaceId, updated);
    });
  }

  // ── multi-mailbox bindings ──────────────────────────────────────────────

  /** Grant/raise an agent's access to a mailbox (optionally as its primary From). */
  async bindMailbox(
    workspaceId: string,
    ucUid: string | null,
    agentId: string,
    input: BindMailboxInput,
  ): Promise<AgentView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id: agentId, workspaceId } });
      if (!agent) return null;
      await this.assertMailboxInWorkspace(tx, workspaceId, input.mailboxAccountId);

      const requested = input.access ?? MailboxAccessLevel.SEND;
      if (input.isPrimary) {
        // A primary mailbox must be sendable — upgrade READ → BOTH.
        const access = requested === MailboxAccessLevel.READ ? MailboxAccessLevel.BOTH : requested;
        await this.upsertBinding(tx, workspaceId, agentId, input.mailboxAccountId, access, false);
        await this.setPrimaryMailbox(tx, workspaceId, agentId, input.mailboxAccountId);
      } else {
        await this.upsertBinding(tx, workspaceId, agentId, input.mailboxAccountId, requested, false);
      }
      // Safety net: enforce the one-primary + cache invariant from ANY state
      // (e.g. re-binding the current primary as non-primary must not orphan the
      // send identity). Idempotent.
      await this.reconcilePrimary(tx, workspaceId, agentId);

      await this.recordAgentAction(
        tx,
        workspaceId,
        AgentActionKind.MAILBOX_ACCESS_GRANTED,
        agent.key,
        ucUid,
        `${input.mailboxAccountId}${input.isPrimary ? ' (primary)' : ''}`,
      );
      const fresh = await tx.agent.findFirstOrThrow({ where: { id: agentId } });
      return this.toViewOne(tx, workspaceId, fresh);
    });
  }

  /** Revoke an agent's access to a mailbox. If it was primary, repoint the cache. */
  async unbindMailbox(
    workspaceId: string,
    ucUid: string | null,
    agentId: string,
    mailboxAccountId: string,
  ): Promise<AgentView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id: agentId, workspaceId } });
      if (!agent) return null;
      const binding = await tx.agentMailbox.findFirst({
        where: { workspaceId, agentId, mailboxAccountId },
      });
      if (binding) {
        await tx.agentMailbox.delete({ where: { id: binding.id } });
        // Re-establish the primary + cache invariant. Handles removing the primary
        // AND a desynced cache that pointed at this now-removed binding regardless
        // of its isPrimary flag.
        await this.reconcilePrimary(tx, workspaceId, agentId);
        await this.recordAgentAction(
          tx,
          workspaceId,
          AgentActionKind.MAILBOX_ACCESS_REVOKED,
          agent.key,
          ucUid,
          mailboxAccountId,
        );
      }
      const fresh = await tx.agent.findFirstOrThrow({ where: { id: agentId } });
      return this.toViewOne(tx, workspaceId, fresh);
    });
  }

  /** Upsert a binding's access (idempotent on (agent, mailbox)). */
  private async upsertBinding(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agentId: string,
    mailboxAccountId: string,
    access: MailboxAccessLevel,
    isPrimary: boolean,
  ): Promise<void> {
    const existing = await tx.agentMailbox.findFirst({
      where: { workspaceId, agentId, mailboxAccountId },
    });
    if (existing) {
      await tx.agentMailbox.update({ where: { id: existing.id }, data: { access, isPrimary } });
    } else {
      await tx.agentMailbox.create({
        data: { workspaceId, agentId, mailboxAccountId, access, isPrimary },
      });
    }
  }

  /**
   * Make `mailboxAccountId` the agent's primary (unset other primaries, upsert a
   * sendable binding, write the cache). Null → clear all primaries + the cache.
   */
  private async setPrimaryMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agentId: string,
    mailboxAccountId: string | null,
  ): Promise<void> {
    await tx.agentMailbox.updateMany({
      where: { workspaceId, agentId, isPrimary: true },
      data: { isPrimary: false },
    });
    if (mailboxAccountId) {
      const existing = await tx.agentMailbox.findFirst({
        where: { workspaceId, agentId, mailboxAccountId },
      });
      const access =
        existing && existing.access === MailboxAccessLevel.READ
          ? MailboxAccessLevel.BOTH
          : (existing?.access ?? MailboxAccessLevel.BOTH);
      await this.upsertBinding(tx, workspaceId, agentId, mailboxAccountId, access, true);
    }
    await tx.agent.update({ where: { id: agentId }, data: { mailboxAccountId } });
  }

  /**
   * Enforce the binding invariant from ANY state: at most one primary binding,
   * and Agent.mailboxAccountId (the send-identity cache resolveSendMailbox reads)
   * === that primary's mailbox, or null when no sendable binding exists. Collapses
   * stray extra primaries and promotes the oldest sendable binding when none is
   * primary. Idempotent — the safety net every bind/unbind ends with.
   */
  private async reconcilePrimary(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agentId: string,
  ): Promise<void> {
    const bindings = await tx.agentMailbox.findMany({
      where: { workspaceId, agentId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    const isSendable = (a: MailboxAccessLevel) =>
      a === MailboxAccessLevel.SEND || a === MailboxAccessLevel.BOTH;
    const primaries = bindings.filter((b) => b.isPrimary);
    // Collapse any extra primaries down to the first.
    for (const extra of primaries.slice(1)) {
      await tx.agentMailbox.update({ where: { id: extra.id }, data: { isPrimary: false } });
    }
    let primary: AgentMailbox | null = primaries[0] ?? null;
    // No primary (or a non-sendable one) → promote the oldest sendable binding.
    if (!primary || !isSendable(primary.access)) {
      if (primary && !isSendable(primary.access)) {
        await tx.agentMailbox.update({ where: { id: primary.id }, data: { isPrimary: false } });
      }
      const next = bindings.find((b) => isSendable(b.access));
      if (next) {
        await tx.agentMailbox.update({ where: { id: next.id }, data: { isPrimary: true } });
        primary = { ...next, isPrimary: true };
      } else {
        primary = null;
      }
    }
    await tx.agent.update({
      where: { id: agentId },
      data: { mailboxAccountId: primary ? primary.mailboxAccountId : null },
    });
  }

  // ── view mapping ────────────────────────────────────────────────────────

  private async toViews(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agents: Agent[],
  ): Promise<AgentView[]> {
    if (agents.length === 0) return [];
    const agentIds = agents.map((a) => a.id);

    const bindings = await tx.agentMailbox.findMany({
      where: { workspaceId, agentId: { in: agentIds } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });

    const mailboxIds = [
      ...new Set([
        ...bindings.map((b) => b.mailboxAccountId),
        ...agents.map((a) => a.mailboxAccountId).filter((v): v is string => !!v),
      ]),
    ];
    const mailboxes = mailboxIds.length
      ? await tx.mailboxAccount.findMany({
          where: { id: { in: mailboxIds }, workspaceId },
          select: { id: true, emailAddress: true },
        })
      : [];
    const addrById = new Map(mailboxes.map((m) => [m.id, m.emailAddress]));

    const keys = agents.map((a) => a.key);
    const grouped = await tx.agentInboxItem.groupBy({
      by: ['draftedBy'],
      where: { workspaceId, state: AgentInboxState.PENDING, draftedBy: { in: keys } },
      _count: { _all: true },
    });
    const pendingByKey = new Map(grouped.map((g) => [g.draftedBy ?? '', g._count._all]));

    const bindingsByAgent = new Map<string, AgentMailbox[]>();
    for (const b of bindings) {
      const list = bindingsByAgent.get(b.agentId);
      if (list) list.push(b);
      else bindingsByAgent.set(b.agentId, [b]);
    }

    return agents.map((a) =>
      this.toView(a, addrById, bindingsByAgent.get(a.id) ?? [], pendingByKey.get(a.key) ?? 0),
    );
  }

  private async toViewOne(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agent: Agent,
  ): Promise<AgentView> {
    const bindings = await tx.agentMailbox.findMany({
      where: { workspaceId, agentId: agent.id },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    const mailboxIds = [
      ...new Set([
        ...bindings.map((b) => b.mailboxAccountId),
        ...(agent.mailboxAccountId ? [agent.mailboxAccountId] : []),
      ]),
    ];
    const mailboxes = mailboxIds.length
      ? await tx.mailboxAccount.findMany({
          where: { id: { in: mailboxIds }, workspaceId },
          select: { id: true, emailAddress: true },
        })
      : [];
    const addrById = new Map(mailboxes.map((m) => [m.id, m.emailAddress]));
    const pending = await tx.agentInboxItem.count({
      where: { workspaceId, state: AgentInboxState.PENDING, draftedBy: agent.key },
    });
    return this.toView(agent, addrById, bindings, pending);
  }

  private toView(
    agent: Agent,
    addrById: Map<string, string>,
    bindings: AgentMailbox[],
    pendingCount: number,
  ): AgentView {
    const mailboxes: AgentMailboxView[] = bindings.map((b) => ({
      mailbox_account_id: b.mailboxAccountId,
      mailbox_address: addrById.get(b.mailboxAccountId) ?? null,
      access: b.access,
      is_primary: b.isPrimary,
    }));
    return {
      id: agent.id,
      key: agent.key,
      display_name: agent.displayName,
      description: agent.description,
      avatar_url: agent.avatarUrl,
      mailbox_account_id: agent.mailboxAccountId,
      mailbox_address: agent.mailboxAccountId ? (addrById.get(agent.mailboxAccountId) ?? null) : null,
      mailboxes,
      autonomy_level: agent.autonomyLevel,
      recipient_policy: (agent.recipientPolicy as Record<string, unknown> | null) ?? null,
      tier: agent.tier,
      manager_agent_key: agent.managerAgentKey,
      paused: agent.paused,
      active: agent.active,
      pending_count: pendingCount,
      created_at: agent.createdAt?.toISOString() ?? null,
      updated_at: agent.updatedAt?.toISOString() ?? null,
    };
  }

  /** Append a governance row to the shared agent-mail action/audit log. */
  private async recordAgentAction(
    tx: WorkspaceTxClient,
    workspaceId: string,
    kind: AgentActionKind,
    agentKey: string | null,
    actorUcUid: string | null,
    detail: string | null,
  ): Promise<void> {
    await tx.agentActionEvent.create({
      data: { workspaceId, kind, agentKey, actorUcUid, detail },
    });
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
