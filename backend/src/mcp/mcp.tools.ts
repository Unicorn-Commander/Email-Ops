/**
 * Tool implementations for the Email-Ops MCP server.
 *
 * Each tool runs as the *calling user*: the controller pulls the user out of the
 * JWT and passes it in. The user carries the verified workspace claim + the
 * verified entitlement SKUs (surfaced by JwtStrategy), so the tools resolve the
 * tenant via the membership gate and re-derive the compose entitlement
 * server-side.
 *
 * THE CONTRACT (matching Customer-Ops' EmailOpsPort — its email-ops.client.ts):
 *   - list_threads_with_contact(workspace_id, contact_id)
 *       -> { threads: ThreadView[] }     (viewer-level; no dual SKU)
 *   - list_thread_messages(workspace_id, thread_id)
 *       -> { messages: MessageView[] }   (viewer-level; previews only)
 *   - compose_email(workspace_id, contact_id, to_address, subject, body, mode,
 *       in_reply_to_thread_id?, external_source, external_ref)
 *       -> MessageComposeView. mode='send' queues delivery; mode='draft' stages
 *       the agent-inbox approval surface. IDEMPOTENT on (workspace_id,
 *       external_source, external_ref). Requires BOTH customer-ops + email-ops.
 *
 * Plus the foundation tools (health, list_my_workspaces) and the agent-inbox
 * approval tools (list_agent_inbox, approve_agent_inbox_item,
 * reject_agent_inbox_item). All data access runs through EmailService inside the
 * RLS transaction.
 */

import { ForbiddenException } from '@nestjs/common';
import { AgentInboxState, MailboxOwnerKind, User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces, MyWorkspace } from '../common/workspace/list-my-workspaces';
import { tenancyEnabled } from '../common/workspace/feature-flags';
import { entitlementsOf, ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { EmailService } from '../email/email.service';
import { checkComposeEntitlement } from '../email/entitlement';
import { AgentsService } from '../agents/agents.service';
import { EmailHealthService } from '../email-health/email-health.service';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { checkCleanerEntitlement } from '../connected-accounts/entitlement';
import {
  CleanupExecutionResult,
  CleanupPlanResult,
  ConnectedProvider,
} from '../connected-accounts/connected-accounts.types';

export class EmailOpsTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly email: EmailService,
    private readonly agents: AgentsService,
    private readonly emailHealthService: EmailHealthService,
    private readonly policy: ProvisioningPolicyService,
    private readonly mailboxes: MailboxAccountsService,
  ) {}

  /** Health/info — safe for any authenticated caller. */
  health(): {
    status: string;
    service: string;
    tenancyEnabled: boolean;
    time: string;
  } {
    return {
      status: 'ok',
      service: 'email-ops',
      tenancyEnabled: tenancyEnabled(),
      time: new Date().toISOString(),
    };
  }

  /** The caller's active workspaces (membership-gated; empty when none). */
  async listMyWorkspaces(user: User): Promise<{ workspaces: MyWorkspace[]; count: number }> {
    const workspaces = await listMyWorkspaces(this.membership, user);
    return { workspaces, count: workspaces.length };
  }

  // ── Conversational provisioning (write) ────────────────────────────────
  // These run AS the calling user: the role is re-derived server-side and the
  // workspace provisioning policy is enforced exactly as on the REST path — so an
  // agent acting for the user can provision only up to that user's permission
  // (allow → apply; approval-gated → file a request a human approves; else 403).

  /** Provision a mailbox by talking to an agent (policy-gated; may queue for approval). */
  async provisionMailbox(
    user: User,
    args: {
      workspace_id?: string;
      email_address: string;
      display_name?: string;
      owner_kind?: string;
      owner_key?: string;
    },
  ): Promise<{ status: string; mailbox?: unknown; request?: unknown }> {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const { workspaceId, role } = await this.membership.resolveWithRole(
      user,
      args.workspace_id ?? (user as WithWorkspaceClaim).__workspaceClaim ?? null,
    );
    this.mailboxes.assertValidAddress(args.email_address);
    const ownerKind = (args.owner_kind ?? 'SHARED') as MailboxOwnerKind;
    const action = ownerKind === MailboxOwnerKind.AGENT ? 'agentMailbox.create' : 'humanMailbox.create';
    const isSelfOwnMailbox = ownerKind === MailboxOwnerKind.HUMAN && !!ucUid && args.owner_key === ucUid;
    const input = {
      emailAddress: args.email_address,
      displayName: args.display_name ?? null,
      ownerKind,
      ownerKey: args.owner_key ?? null,
    };
    const decision = await this.policy.authorize(workspaceId, ucUid, role, action, { isSelfOwnMailbox });
    if (decision === 'requires_approval') {
      const request = await this.policy.fileRequest(workspaceId, ucUid, {
        kind: ownerKind === MailboxOwnerKind.AGENT ? 'AGENT_MAILBOX' : 'HUMAN_MAILBOX',
        action: 'create',
        payload: input,
        summary: `Create ${ownerKind.toLowerCase()} mailbox ${args.email_address}`,
      });
      return { status: 'pending_approval', request };
    }
    const mailbox = await this.mailboxes.createMailbox(workspaceId, ucUid, input);
    return { status: 'created', mailbox };
  }

  /** Provision an agent by talking to an agent (policy-gated; may queue for approval). */
  async provisionAgent(
    user: User,
    args: {
      workspace_id?: string;
      key: string;
      display_name: string;
      description?: string;
      autonomy_level?: string;
      tier?: string;
      manager_agent_key?: string;
      mailbox_account_id?: string;
    },
  ): Promise<{ status: string; agent?: unknown; request?: unknown }> {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const { workspaceId, role } = await this.membership.resolveWithRole(
      user,
      args.workspace_id ?? (user as WithWorkspaceClaim).__workspaceClaim ?? null,
    );
    const input = {
      key: args.key,
      displayName: args.display_name,
      description: args.description ?? null,
      mailboxAccountId: args.mailbox_account_id ?? null,
      autonomyLevel: args.autonomy_level as never,
      tier: args.tier as never,
      managerAgentKey: args.manager_agent_key ?? null,
    };
    const decision = await this.policy.authorize(workspaceId, ucUid, role, 'agent.create');
    if (decision === 'requires_approval') {
      const request = await this.policy.fileRequest(workspaceId, ucUid, {
        kind: 'AGENT',
        action: 'create',
        payload: input,
        summary: `Create agent ${args.key}`,
      });
      return { status: 'pending_approval', request };
    }
    const agent = await this.agents.createAgent(workspaceId, ucUid, input);
    return { status: 'created', agent };
  }

  // ── Email-steward tools (observability for a Mail-Ops agent) ───────────

  /** The email-ops health + setup report (engine, mailboxes, queue, agents). */
  async emailHealth(user: User, args: { workspace_id?: string }): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.emailHealthService.getReport(workspaceId, ucUidOf(user as WithWorkspaceClaim));
  }

  /** The registered agent fleet (the registry: keys, autonomy, mailboxes). */
  async listAgents(
    user: User,
    args: { workspace_id?: string },
  ): Promise<{ agents: unknown[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const items = await this.agents.listAgents(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { agents: items, count: items.length };
  }

  // ── EmailOpsPort contract tools ────────────────────────────────────────

  async listThreadsWithContact(
    user: User,
    args: { workspace_id?: string; contact_id: string },
  ): Promise<{ threads: unknown[] }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const threads = await this.email.listThreadsWithContact(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.contact_id,
    );
    return { threads };
  }

  async listThreadMessages(
    user: User,
    args: { workspace_id?: string; thread_id: string },
  ): Promise<{ messages: unknown[] }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const messages = await this.email.listThreadMessages(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.thread_id,
    );
    return { messages };
  }

  async composeEmail(
    user: User,
    args: {
      workspace_id?: string;
      contact_id?: string;
      to_address: string;
      subject: string;
      body: string;
      mode?: 'send' | 'draft';
      in_reply_to_thread_id?: string;
      external_source: string;
      external_ref: string;
    },
  ): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);

    // Defense-in-depth: re-derive the dual-SKU gate server-side off the verified
    // token. A federated call can never bypass the entitlement boundary.
    const gate = checkComposeEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }

    return this.email.composeEmail(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      contactId: args.contact_id ?? null,
      toAddress: args.to_address,
      subject: args.subject,
      body: args.body,
      mode: args.mode === 'draft' ? 'draft' : 'send',
      inReplyToThreadId: args.in_reply_to_thread_id ?? null,
      externalSource: args.external_source,
      externalRef: args.external_ref,
      draftedBy: args.external_source,
    });
  }

  // ── agent-inbox approval tools ─────────────────────────────────────────

  async listAgentInbox(
    user: User,
    args: { workspace_id?: string; state?: 'pending' | 'approved' | 'rejected' },
  ): Promise<{ items: unknown[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const state = this.inboxState(args.state);
    const items = await this.email.listAgentInbox(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      state,
    );
    return { items, count: items.length };
  }

  async approveAgentInboxItem(
    user: User,
    args: { workspace_id?: string; item_id: string; note?: string },
  ): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    // Approving a draft is the human-in-the-loop SEND — gate it like a compose.
    const gate = checkComposeEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    const res = await this.email.approveAgentInboxItem(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.item_id,
      args.note ?? null,
    );
    if (!res) return { ok: false, reason: 'agent-inbox item not found in this workspace' };
    return { ok: true, ...res };
  }

  async rejectAgentInboxItem(
    user: User,
    args: { workspace_id?: string; item_id: string; note?: string },
  ): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const res = await this.email.rejectAgentInboxItem(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.item_id,
      args.note ?? null,
    );
    if (!res) return { ok: false, reason: 'agent-inbox item not found in this workspace' };
    return { ok: true, ...res };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Resolve + authorize the workspace for this user (membership-gated when
   *  tenancy is on; the requested id is the wire claim from the tool args). */
  private async resolve(user: User, requested?: string): Promise<string> {
    return this.membership.resolveAndAuthorize(user, requested ?? null);
  }

  private inboxState(s?: string): AgentInboxState | undefined {
    switch ((s ?? '').toLowerCase()) {
      case 'approved':
        return AgentInboxState.APPROVED;
      case 'rejected':
        return AgentInboxState.REJECTED;
      case 'pending':
        return AgentInboxState.PENDING;
      default:
        return undefined; // service defaults to PENDING
    }
  }
}

export class ConnectedAccountsTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly connectedAccounts: ConnectedAccountsService,
  ) {}

  async listConnectedAccounts(
    user: User,
    args: { workspace_id?: string },
  ): Promise<{ accounts: unknown[] }> {
    await this.resolve(user, args.workspace_id);
    return this.connectedAccounts.listConnectedAccounts(user);
  }

  async getInboxStats(
    user: User,
    args: { workspace_id?: string; provider: 'gmail' | 'microsoft' },
  ): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.getInboxStats(user, args.provider);
  }

  async analyzeInbox(
    user: User,
    args: { workspace_id?: string; provider: 'gmail' | 'microsoft' },
  ): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.analyzeInbox(user, args.provider);
  }

  async planCleanup(
    user: User,
    args: {
      workspace_id?: string;
      provider: ConnectedProvider;
      criteria?: Record<string, unknown>;
    },
  ): Promise<CleanupPlanResult> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.planCleanup(user, args.provider, args.criteria ?? {});
  }

  async cleanTrash(
    user: User,
    args: {
      workspace_id?: string;
      provider: ConnectedProvider;
      criteria?: Record<string, unknown>;
    },
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.stageCleanupRequest(
      user,
      args.provider,
      'trash',
      'TRASH',
      args.criteria ?? {},
    );
  }

  async cleanDelete(
    user: User,
    args: {
      workspace_id?: string;
      provider: ConnectedProvider;
      criteria?: Record<string, unknown>;
    },
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.stageCleanupRequest(
      user,
      args.provider,
      'delete',
      'DELETE',
      args.criteria ?? {},
    );
  }

  async organizeMessages(
    user: User,
    args: {
      workspace_id?: string;
      provider: ConnectedProvider;
      criteria?: Record<string, unknown>;
    },
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.stageCleanupRequest(
      user,
      args.provider,
      'archive',
      'ORGANIZE',
      args.criteria ?? {},
    );
  }

  async unsubscribeSender(
    user: User,
    args: {
      workspace_id?: string;
      provider: ConnectedProvider;
      sender_group: string[];
    },
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.stageCleanupRequest(
      user,
      args.provider,
      'unsubscribe',
      'UNSUBSCRIBE',
      { senderGroup: args.sender_group },
    );
  }

  async undoBatch(
    user: User,
    args: { workspace_id?: string; provider: ConnectedProvider; batch_id: string },
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    return this.connectedAccounts.undoBatch(user, args.provider, args.batch_id);
  }

  private async resolve(user: User, requested?: string): Promise<string> {
    return this.membership.resolveAndAuthorize(user, requested ?? null);
  }
}
