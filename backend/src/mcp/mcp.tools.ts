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
import {
  AgentInboxKind,
  AgentInboxState,
  MailboxOwnerKind,
  MessageDisposition,
  SenderPolicyKind,
  SenderPolicyScope,
  UiCommandKind,
  User,
  WorkspaceRole,
} from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces, MyWorkspace } from '../common/workspace/list-my-workspaces';
import { tenancyEnabled } from '../common/workspace/feature-flags';
import { entitlementsOf, ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { EmailService } from '../email/email.service';
import { MailFolder } from '../email/email.types';
import { checkComposeEntitlement } from '../email/entitlement';
import { AgentsService } from '../agents/agents.service';
import { EmailHealthService } from '../email-health/email-health.service';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';
import { DispositionService } from '../mail-triage/disposition.service';
import { SenderPolicyService } from '../mail-triage/sender-policy.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { checkCleanerEntitlement } from '../connected-accounts/entitlement';
import {
  CleanupExecutionResult,
  CleanupPlanResult,
  ConnectedProvider,
} from '../connected-accounts/connected-accounts.types';
import { UiCommandService } from '../ui-commands/ui-commands.service';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { MailDomainService } from '../mail-engine-admin/mail-domain.service';
import { DEFAULT_MAILBOX_QUOTA_BYTES } from '../mail-engine-admin/mail-engine-admin.constants';
import { SchedulingService } from '../scheduling/scheduling.service';
import { AgentViewService } from '../agent-view/agent-view.service';
import { MailRulesService } from '../mail-rules/mail-rules.service';
import { MailRuleView } from '../mail-rules/mail-rules.types';
import { TrustedCorrespondentsService } from '../trusted-correspondents/trusted-correspondents.service';
import { TrustedCorrespondentView } from '../email/email.types';

export class EmailOpsTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly email: EmailService,
    private readonly agents: AgentsService,
    private readonly emailHealthService: EmailHealthService,
    private readonly policy: ProvisioningPolicyService,
    private readonly mailboxes: MailboxAccountsService,
    private readonly disposition: DispositionService,
    private readonly senderPolicy: SenderPolicyService,
    private readonly admin: MailEngineAdminPort,
    private readonly mailDomains: MailDomainService,
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

  // ── Mail triage (write; runs AS the user, member-level) ─────────────────
  // The agent-driven analogue of the human triage UI: an agent on a loop can
  // archive/trash a thread or route junk to Spam, and block/trust senders — only
  // within a workspace the calling user is a member of.

  /** Move a thread to a folder (INBOX/ARCHIVE/TRASH/SPAM). */
  async setDisposition(
    user: User,
    args: { workspace_id?: string; thread_id: string; disposition: string },
  ): Promise<{ status: string; disposition: unknown }> {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const workspaceId = await this.resolve(user, args.workspace_id);
    const view = await this.disposition.setDisposition(
      workspaceId,
      ucUid,
      args.thread_id,
      args.disposition as MessageDisposition,
      { agentKey: null },
    );
    return { status: 'ok', disposition: view };
  }

  /** Block or allow (trust) a sender — exact address or whole domain. */
  async setSenderPolicy(
    user: User,
    args: { workspace_id?: string; scope?: string; pattern: string; kind: string; reason?: string },
  ): Promise<{ status: string; sender_policy: unknown }> {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const workspaceId = await this.resolve(user, args.workspace_id);
    const rule = await this.senderPolicy.set(workspaceId, ucUid, {
      scope: (args.scope ?? 'ADDRESS') as SenderPolicyScope,
      pattern: args.pattern,
      kind: args.kind as SenderPolicyKind,
      reason: args.reason ?? null,
    });
    return { status: 'ok', sender_policy: rule };
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

  // ── Mail read plane (agent list/search/read + read-state/bulk triage) ──
  // The agents' READ surface over their OWN mailboxes — thin wrappers over the
  // EXACT EmailService/DispositionService methods the human mail BFF
  // (mail.controller.ts) uses, so there is ONE implementation, ONE RLS path, and
  // the SAME degrade-clean contract (reads → [] when the engine is dormant, never
  // a 500). Reads are member-level (resolve-and-authorize the workspace); set_read
  // + bulk_disposition are member-level writes. The per-mailbox owner fence
  // (EmailService.mayActThroughMailbox) is preserved for external mailboxes — no
  // cross-tenant read is introduced.

  /** List a mailbox's threads for a folder — or the UNIFIED inbox when no mailbox_id. */
  async listThreads(
    user: User,
    args: {
      workspace_id?: string;
      mailbox_id?: string;
      folder?: string;
      q?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ threads: unknown[]; count: number; folder: MailFolder }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const folder = (args.folder ?? 'inbox') as MailFolder;
    const q = args.q?.trim() ? args.q : null;
    const threads = args.mailbox_id
      ? await this.email.listMailboxInbox(
          workspaceId,
          ucUid,
          args.mailbox_id,
          args.limit,
          folder,
          q,
          args.offset,
        )
      : await this.email.listAggregateInbox(workspaceId, ucUid, folder, args.limit, q, args.offset);
    return { threads, count: threads.length, folder };
  }

  /** Full thread messages WITH bodies (name a mailbox → live engine detail / external provider). */
  async getThread(
    user: User,
    args: { workspace_id?: string; thread_id: string; mailbox_id?: string },
  ): Promise<{ messages: unknown[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const messages = await this.email.listThreadMessages(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.thread_id,
      args.mailbox_id,
    );
    return { messages, count: messages.length };
  }

  /** Full-text search over a mailbox (or the unified inbox), reusing the engine's `q` path. */
  async searchMail(
    user: User,
    args: {
      workspace_id?: string;
      mailbox_id?: string;
      q: string;
      folder?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ threads: unknown[]; count: number; q: string }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const folder = (args.folder ?? 'inbox') as MailFolder;
    const threads = args.mailbox_id
      ? await this.email.listMailboxInbox(
          workspaceId,
          ucUid,
          args.mailbox_id,
          args.limit,
          folder,
          args.q,
          args.offset,
        )
      : await this.email.listAggregateInbox(workspaceId, ucUid, folder, args.limit, args.q, args.offset);
    return { threads, count: threads.length, q: args.q };
  }

  /** Mark a thread read/unread — per-mailbox when mailbox_id is given, else across the workspace. */
  async setRead(
    user: User,
    args: { workspace_id?: string; thread_id: string; read: boolean; mailbox_id?: string },
  ): Promise<{ thread_id: string; read: boolean; updated: boolean }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    if (args.mailbox_id) {
      return this.email.setThreadReadState(workspaceId, ucUid, args.mailbox_id, args.thread_id, args.read);
    }
    const updated = await this.email.setThreadReadAcrossMailboxes(
      workspaceId,
      ucUid,
      args.thread_id,
      args.read,
    );
    return { thread_id: args.thread_id, read: args.read, updated };
  }

  /** Bulk-triage a SET of threads into a folder (the REST bulk-disposition path). */
  async bulkDisposition(
    user: User,
    args: { workspace_id?: string; thread_ids: string[]; disposition: string },
  ): Promise<{ succeeded: string[]; failed: string[] }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const target = args.disposition as MessageDisposition;
    const succeeded: string[] = [];
    const failed: string[] = [];
    // Per-thread isolation: one failing thread never fails the batch (mirrors the
    // mail.controller bulk route exactly — the SAME DispositionService.setDisposition).
    const settled = await Promise.allSettled(
      args.thread_ids.map((threadId) =>
        this.disposition.setDisposition(workspaceId, ucUid, threadId, target, { agentKey: null }),
      ),
    );
    settled.forEach((r, i) => {
      const id = args.thread_ids[i];
      if (r.status === 'fulfilled') succeeded.push(id);
      else failed.push(id);
    });
    return { succeeded, failed };
  }

  // ── custom folders / labels (per-mailbox, James JMAP) ──────────────────
  // Thin wrappers over the SAME EmailService folder methods the human mail BFF
  // uses — one RLS path, degrade-clean. A folder is a per-mailbox object, so
  // every tool takes a mailbox_id.

  /** List a mailbox's folders (system role + custom) — the agent's folder rail. */
  async listFolders(
    user: User,
    args: { workspace_id?: string; mailbox_id: string },
  ): Promise<{ folders: unknown[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const folders = await this.email.listMailboxFolders(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
    );
    return { folders, count: folders.length };
  }

  /** Create a custom folder (optionally nested under parent_id). */
  async createFolder(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; name: string; parent_id?: string },
  ): Promise<{ id: string | null; created: boolean }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const created = await this.email.createMailboxFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
      args.name,
      args.parent_id?.trim() || null,
    );
    return { id: created?.id ?? null, created: !!created };
  }

  /** Rename a custom folder. */
  async renameFolder(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; folder_id: string; name: string },
  ): Promise<{ updated: boolean }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.email.renameMailboxFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
      args.folder_id,
      args.name,
    );
  }

  /** Delete a CUSTOM folder — a system/role folder is refused (deleted:false). */
  async deleteFolder(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; folder_id: string },
  ): Promise<{ deleted: boolean }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.email.deleteMailboxFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
      args.folder_id,
    );
  }

  /** Move a thread INTO a custom folder (by folder_id). Member-level write. */
  async moveToFolder(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; thread_id: string; folder_id: string },
  ): Promise<{ moved: boolean }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.email.moveThreadToCustomFolder(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
      args.thread_id,
      args.folder_id,
    );
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
    args: { workspace_id?: string; item_id: string; note?: string; trust_recipients?: boolean },
  ): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    // Gate BY KIND (mirrors the REST approve): peek first so a missing/foreign
    // id reads as not-found before any entitlement verdict. Approving an EMAIL
    // draft is the human-in-the-loop SEND → the dual-SKU compose gate; approving
    // a CLEANUP item merely runs a cleaner batch → the cleaner SKU only.
    const kind = await this.email.peekAgentInboxKind(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.item_id,
    );
    if (kind === null) return { ok: false, reason: 'agent-inbox item not found in this workspace' };
    const gate =
      kind === AgentInboxKind.CLEANUP
        ? checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId)
        : checkComposeEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    const res = await this.email.approveAgentInboxItem(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.item_id,
      args.note ?? null,
      // Wave 7 learning: default TRUE; trust_recipients:false approves without
      // trusting the external recipients.
      args.trust_recipients,
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


  // ── Mail-engine admin tools (control-plane; domains / quotas / teardown) ─
  // Read tools are member-level (resolve-and-authorize the workspace).
  // Write tools are OWNER-only — the role is re-derived server-side via
  // resolveWithRole; when tenancy is OFF the single-tenant operator always
  // carries OWNER. Engine access remains degrade-clean when no admin endpoint
  // is wired; tenant-boundary violations fail closed before any engine call.

  /** List engine domains bound to this workspace (member-level read). */
  async listMailDomains(
    user: User,
    args: { workspace_id?: string },
  ): Promise<{ domains: unknown[] } | { status: string }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const bindings = await this.mailDomains.listDomains(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
    );
    if (!this.admin.isConfigured()) return { status: 'engine_not_configured' };
    const owned = new Set(bindings.map((binding) => binding.domain));
    const domains = (await this.admin.listDomains()).filter((item) => {
      try {
        return owned.has(this.mailDomains.canonicalDomain(item.domain));
      } catch {
        return false;
      }
    });
    return { domains };
  }

  /** List engine-hosted accounts under this workspace's bound domains. */
  async listMailAccounts(
    user: User,
    args: { workspace_id?: string },
  ): Promise<{ accounts: unknown[] } | { status: string }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const bindings = await this.mailDomains.listDomains(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
    );
    if (!this.admin.isConfigured()) return { status: 'engine_not_configured' };
    const owned = new Set(bindings.map((binding) => binding.domain));
    const accounts = (await this.admin.listAccounts()).filter((item) => {
      try {
        return owned.has(this.mailDomains.domainOf(item.address));
      } catch {
        return false;
      }
    });
    return { accounts };
  }

  /** Ensure a domain is served by the mail engine (OWNER-only; idempotent). */
  async ensureMailDomain(
    user: User,
    args: { workspace_id?: string; domain: string },
  ): Promise<{ status: string; result?: unknown }> {
    const { workspaceId, role } = await this.membership.resolveWithRole(
      user,
      args.workspace_id ?? (user as WithWorkspaceClaim).__workspaceClaim ?? null,
    );
    if (role !== WorkspaceRole.OWNER) return { status: 'forbidden' };
    const binding = await this.mailDomains.bindDomain(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.domain,
    );
    if (!this.admin.isConfigured()) return { status: 'engine_not_configured' };
    const result = await this.admin.ensureDomain(binding.domain);
    return { status: result.provisioned ? 'ok' : 'failed', result };
  }

  /** Remove a domain from the mail engine (OWNER-only; idempotent). */
  async removeMailDomain(
    user: User,
    args: { workspace_id?: string; domain: string },
  ): Promise<{ status: string; result?: unknown }> {
    const { workspaceId, role } = await this.membership.resolveWithRole(
      user,
      args.workspace_id ?? (user as WithWorkspaceClaim).__workspaceClaim ?? null,
    );
    if (role !== WorkspaceRole.OWNER) return { status: 'forbidden' };
    const binding = await this.mailDomains.assertWorkspaceOwnsDomain(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.domain,
    );
    if (!this.admin.isConfigured()) return { status: 'engine_not_configured' };
    const result = await this.admin.removeDomain(binding.domain);
    return { status: result.provisioned ? 'ok' : 'failed', result };
  }

  /** Set a per-account storage quota in bytes (OWNER-only; pass null to clear). */
  async setMailboxQuota(
    user: User,
    args: { workspace_id?: string; address: string; quota_bytes?: number | null },
  ): Promise<{ status: string; result?: unknown }> {
    const { workspaceId, role } = await this.membership.resolveWithRole(
      user,
      args.workspace_id ?? (user as WithWorkspaceClaim).__workspaceClaim ?? null,
    );
    if (role !== WorkspaceRole.OWNER) return { status: 'forbidden' };
    await this.mailDomains.assertWorkspaceOwnsDomain(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      this.mailDomains.domainOf(args.address),
    );
    if (!this.admin.isConfigured()) return { status: 'engine_not_configured' };
    const quotaBytes =
      args.quota_bytes === undefined ? DEFAULT_MAILBOX_QUOTA_BYTES : args.quota_bytes;
    const result = await this.admin.setQuota(args.address, quotaBytes);
    return { status: result.provisioned ? 'ok' : 'failed', result };
  }

  /**
   * Remove an engine account (OWNER-only; idempotent).
   * Tears down the mail-server login and storage only. Does NOT touch the
   * SoR MailboxAccount row or stored message records — call this when the
   * engine row must be cleaned up independently (e.g. migration clean-ups,
   * re-provisioning after the SoR has already been deleted).
   */
  async removeMailboxEngine(
    user: User,
    args: { workspace_id?: string; address: string },
  ): Promise<{ status: string; result?: unknown }> {
    const { workspaceId, role } = await this.membership.resolveWithRole(
      user,
      args.workspace_id ?? (user as WithWorkspaceClaim).__workspaceClaim ?? null,
    );
    if (role !== WorkspaceRole.OWNER) return { status: 'forbidden' };
    await this.mailDomains.assertWorkspaceOwnsDomain(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      this.mailDomains.domainOf(args.address),
    );
    if (!this.admin.isConfigured()) return { status: 'engine_not_configured' };
    const result = await this.admin.removeAccount(args.address);
    return { status: result.provisioned ? 'ok' : 'failed', result };
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

/**
 * UiControlTools — the "agent controls the UI" tools (the AG-UI / frontend-tools
 * surface). Each runs AS the calling user (member-level; the membership gate is
 * the only fence — a UI command has NO external side effect, so it BYPASSES the
 * compose autonomy / agent-inbox approval path) and ENQUEUES a command addressed
 * to that user's (workspaceId, ucUid). The user's open cockpit drains + applies
 * it. `ui_compose` only PREFILLS the composer — it never sends (the human stays
 * in the loop for anything irreversible).
 */
export class UiControlTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly uiCommands: UiCommandService,
  ) {}

  /** Navigate the cockpit to an app route (e.g. /mail, /agents, /agent-inbox). */
  async navigate(user: User, args: { workspace_id?: string; path: string }): Promise<unknown> {
    return this.enqueue(user, args.workspace_id, UiCommandKind.NAVIGATE, { path: args.path });
  }

  /** Open a specific mail thread (navigates to /mail + selects the thread). */
  async openThread(
    user: User,
    args: { workspace_id?: string; mailbox_id?: string; thread_id: string },
  ): Promise<unknown> {
    return this.enqueue(user, args.workspace_id, UiCommandKind.OPEN_THREAD, {
      mailbox_id: args.mailbox_id ?? null,
      thread_id: args.thread_id,
    });
  }

  /** Pre-fill the composer (does NOT send — the human reviews + sends). */
  async compose(
    user: User,
    args: { workspace_id?: string; to?: string; subject?: string; body?: string; thread_id?: string },
  ): Promise<unknown> {
    return this.enqueue(user, args.workspace_id, UiCommandKind.COMPOSE, {
      to: args.to ?? null,
      subject: args.subject ?? null,
      body: args.body ?? null,
      thread_id: args.thread_id ?? null,
    });
  }

  /** Switch the active Space (a Space id, or 'all' for no filter). */
  async switchSpace(
    user: User,
    args: { workspace_id?: string; space_id: string },
  ): Promise<unknown> {
    return this.enqueue(user, args.workspace_id, UiCommandKind.SWITCH_SPACE, {
      space_id: args.space_id,
    });
  }

  /** Show a toast in the cockpit (an agent → human status message). */
  async notify(
    user: User,
    args: { workspace_id?: string; title: string; body?: string; tone?: 'info' | 'success' | 'warning' },
  ): Promise<unknown> {
    return this.enqueue(user, args.workspace_id, UiCommandKind.NOTIFY, {
      title: args.title,
      body: args.body ?? null,
      tone: args.tone ?? 'info',
    });
  }

  /** Resolve the workspace (membership-gated) + the acting ucUid, then enqueue. */
  private async enqueue(
    user: User,
    requested: string | undefined,
    kind: UiCommandKind,
    payload: Record<string, unknown>,
  ): Promise<{ enqueued: true; command_id: string; kind: string }> {
    const workspaceId = await this.membership.resolveAndAuthorize(user, requested ?? null);
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const { id } = await this.uiCommands.enqueue(workspaceId, ucUid, kind, payload);
    return { enqueued: true, command_id: id, kind: kind.toLowerCase() };
  }
}

/**
 * SchedulingTools — the snooze / send-later surface, giving an agent the SAME
 * powers the human has over the REST routes in scheduling.controller.ts. Each
 * tool runs AS the calling user: the membership gate resolves + authorizes the
 * workspace, then the SAME SchedulingService the REST controller uses does the
 * work (one implementation, one RLS path). Degrade-clean: snoozed:false /
 * scheduled:false / [] when the sovereign mailbox is dormant or external — never
 * a 500. The per-mailbox sovereign-owner fence lives inside SchedulingService.
 */
export class SchedulingTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly scheduling: SchedulingService,
  ) {}

  /** Snooze a thread out of Inbox until a chosen time (the scheduler wakes it). */
  async snoozeThread(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; thread_id: string; until: string },
  ): Promise<{ snoozed: boolean; item: unknown }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.scheduling.snoozeThread(user, {
      workspaceId,
      mailboxId: args.mailbox_id,
      threadId: args.thread_id,
      until: new Date(args.until),
    });
  }

  /** Cancel an active snooze and restore the thread to Inbox. */
  async unsnoozeThread(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; thread_id: string },
  ): Promise<{ unsnoozed: boolean }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.scheduling.unsnoozeThread(user, {
      workspaceId,
      mailboxId: args.mailbox_id,
      threadId: args.thread_id,
    });
  }

  /** List the active snoozed threads for one sovereign mailbox. */
  async listSnoozed(
    user: User,
    args: { workspace_id?: string; mailbox_id: string },
  ): Promise<{ snoozed: unknown[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const snoozed = await this.scheduling.listSnoozed(user, workspaceId, args.mailbox_id);
    return { snoozed, count: snoozed.length };
  }

  /** Schedule an outbound email to send later from one sovereign mailbox. */
  async scheduleSend(
    user: User,
    args: {
      workspace_id?: string;
      mailbox_id: string;
      to_address: string;
      subject?: string;
      body?: string;
      body_html?: string;
      to_addresses?: string[];
      cc?: string[];
      bcc?: string[];
      in_reply_to_thread_id?: string;
      send_at: string;
    },
  ): Promise<{ scheduled: boolean; item: unknown }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.scheduling.scheduleSend(user, {
      workspaceId,
      mailboxId: args.mailbox_id,
      payload: {
        toAddress: args.to_address,
        subject: args.subject ?? '',
        body: args.body ?? '',
        bodyHtml: args.body_html ?? null,
        toAddresses: args.to_addresses,
        cc: args.cc,
        bcc: args.bcc,
        inReplyToThreadId: args.in_reply_to_thread_id ?? null,
      },
      sendAt: new Date(args.send_at),
    });
  }

  /** Cancel a pending scheduled send by id. */
  async cancelScheduledSend(
    user: User,
    args: { workspace_id?: string; id: string },
  ): Promise<{ cancelled: boolean }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.scheduling.cancelScheduledSend(user, workspaceId, args.id);
  }

  /** List the pending scheduled sends for one sovereign mailbox. */
  async listScheduledSends(
    user: User,
    args: { workspace_id?: string; mailbox_id: string },
  ): Promise<{ scheduled_sends: unknown[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const scheduled_sends = await this.scheduling.listScheduledSends(user, workspaceId, args.mailbox_id);
    return { scheduled_sends, count: scheduled_sends.length };
  }

  private async resolve(user: User, requested?: string): Promise<string> {
    return this.membership.resolveAndAuthorize(user, requested ?? null);
  }
}

/**
 * AgentViewTools — the per-agent mailbox surface, giving an agent the SAME
 * roster + drill-in the human has over the REST routes in
 * agent-view.controller.ts. Runs AS the calling user: the membership gate
 * authorizes the workspace, then the SAME AgentViewService the REST controller
 * uses composes the view (one RLS path). Read-only.
 */
export class AgentViewTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly agentView: AgentViewService,
  ) {}

  /** The lightweight per-agent mailbox roster (address, unread, pending). */
  async listAgentMailboxes(user: User, args: { workspace_id?: string }): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.agentView.listAgentMailboxes(user, workspaceId);
  }

  /** One agent's mailbox world: mailbox, recent threads, approval queue, stats. */
  async getAgentMailbox(
    user: User,
    args: { workspace_id?: string; agent_id: string; thread_limit?: number },
  ): Promise<unknown> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const view = await this.agentView.getAgentMailbox(user, {
      workspaceId,
      agentId: args.agent_id,
      threadLimit: args.thread_limit,
    });
    return view ?? { status: 'not_found', reason: 'agent not found in this workspace' };
  }

  private async resolve(user: User, requested?: string): Promise<string> {
    return this.membership.resolveAndAuthorize(user, requested ?? null);
  }
}

/**
 * MailRulesTools — the inbound mail-rules surface, giving an agent the SAME
 * rule CRUD the human has over the REST routes in mail-rules.controller.ts.
 * Each tool runs AS the calling user: the membership gate resolves + authorizes
 * the workspace, then the SAME MailRulesService the REST controller uses does
 * the work (one implementation, one RLS path). The per-mailbox tenant fence +
 * sovereign-owner check (assertMailbox) and ALL match/actions validation live
 * INSIDE the service — a bad payload surfaces as its own BadRequestException,
 * exactly as on REST — so no extra entitlement gate is added here (mirrors
 * SchedulingTools).
 */
export class MailRulesTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly mailRules: MailRulesService,
  ) {}

  /** List one mailbox's inbound rules, priority ascending. */
  async listMailRules(
    user: User,
    args: { workspace_id?: string; mailbox_id: string },
  ): Promise<{ rules: MailRuleView[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const rules = await this.mailRules.list(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
    );
    return { rules, count: rules.length };
  }

  /** Create a rule (the service validates name/match/actions + the per-mailbox cap). */
  async createMailRule(
    user: User,
    args: {
      workspace_id?: string;
      mailbox_id: string;
      name: string;
      match: Record<string, unknown>;
      actions: unknown[];
      enabled?: boolean;
      priority?: number;
    },
  ): Promise<MailRuleView> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.mailRules.create(workspaceId, ucUidOf(user as WithWorkspaceClaim), args.mailbox_id, {
      name: args.name,
      enabled: args.enabled,
      priority: args.priority,
      match: args.match,
      actions: args.actions,
    });
  }

  /** Update any subset of a rule's fields; provided fields re-validate as on create. */
  async updateMailRule(
    user: User,
    args: {
      workspace_id?: string;
      mailbox_id: string;
      rule_id: string;
      name?: string;
      match?: Record<string, unknown>;
      actions?: unknown[];
      enabled?: boolean;
      priority?: number;
    },
  ): Promise<MailRuleView | { status: string; reason: string }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const view = await this.mailRules.update(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
      args.rule_id,
      {
        name: args.name,
        enabled: args.enabled,
        priority: args.priority,
        match: args.match,
        actions: args.actions,
      },
    );
    return view ?? { status: 'not_found', reason: 'rule not found in this mailbox' };
  }

  /** Delete a rule from one mailbox. */
  async deleteMailRule(
    user: User,
    args: { workspace_id?: string; mailbox_id: string; rule_id: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const removed = await this.mailRules.remove(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.mailbox_id,
      args.rule_id,
    );
    if (!removed) return { ok: false, reason: 'rule not found in this mailbox' };
    return { ok: true };
  }

  private async resolve(user: User, requested?: string): Promise<string> {
    return this.membership.resolveAndAuthorize(user, requested ?? null);
  }
}

/**
 * TrustedCorrespondentTools (Wave 7) — the MCP twin of the trusted-
 * correspondents REST routes: list the outbound trust allowlist, trust an
 * address manually, untrust one. Each tool runs AS the calling user through the
 * membership gate into the SAME TrustedCorrespondentsService the REST
 * controller uses (one implementation, one RLS path; the service is the
 * validator — a bad address surfaces as its own BadRequestException).
 */
export class TrustedCorrespondentTools {
  constructor(
    private readonly membership: MembershipService,
    private readonly trusted: TrustedCorrespondentsService,
  ) {}

  /** The workspace's trusted correspondents (the L2 external auto-send allowlist). */
  async listTrustedCorrespondents(
    user: User,
    args: { workspace_id?: string },
  ): Promise<{ items: TrustedCorrespondentView[]; count: number }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const items = await this.trusted.list(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items, count: items.length };
  }

  /** Manually trust an address (source MANUAL; idempotent). */
  async trustCorrespondent(
    user: User,
    args: { workspace_id?: string; address: string; note?: string; scope?: 'address' | 'domain' },
  ): Promise<TrustedCorrespondentView> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    return this.trusted.add(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      address: args.address,
      note: args.note ?? null,
      scope: args.scope ?? null,
    });
  }

  /** Untrust an address (delete its row). */
  async untrustCorrespondent(
    user: User,
    args: { workspace_id?: string; address: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    const workspaceId = await this.resolve(user, args.workspace_id);
    const removed = await this.trusted.removeByAddress(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      args.address,
    );
    if (!removed) return { ok: false, reason: 'address is not a trusted correspondent in this workspace' };
    return { ok: true };
  }

  private async resolve(user: User, requested?: string): Promise<string> {
    return this.membership.resolveAndAuthorize(user, requested ?? null);
  }
}
