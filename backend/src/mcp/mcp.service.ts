/**
 * Builds a per-request MCP server scoped to one authenticated user.
 *
 * Brigade (or any MCP client — including Customer-Ops federating us) opens a
 * Streamable HTTP session against /api/v1/mcp. For each request we mint a fresh
 * McpServer + transport, register the Email-Ops tool set, and let the SDK handle
 * the protocol. The user is captured by closure on the tool handlers, so all
 * data access runs with their identity / membership and inside the RLS
 * transaction (via EmailService).
 *
 * THE CONTRACT (what Customer-Ops calls — its email-ops.client.ts): the three
 * tools list_threads_with_contact / list_thread_messages / compose_email, plus
 * the foundation tools and the agent-inbox approval tools. Each tool's payload
 * is returned BOTH as `structuredContent` (the cockpit's client reads this
 * first) AND as a text content block (the fallback), so the federation seam maps
 * cleanly.
 */

import { Injectable, Logger } from '@nestjs/common';
import { User } from '@prisma/client';
import { z } from 'zod';
import { MembershipService } from '../common/workspace/membership.service';
import { EmailService } from '../email/email.service';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import {
  AgentViewTools,
  ConnectedAccountsTools,
  EmailOpsTools,
  MailRulesTools,
  SchedulingTools,
  TrustedCorrespondentTools,
  UiControlTools,
} from './mcp.tools';
import { AgentsService } from '../agents/agents.service';
import { EmailHealthService } from '../email-health/email-health.service';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';
import { DispositionService } from '../mail-triage/disposition.service';
import { SenderPolicyService } from '../mail-triage/sender-policy.service';
import { UiCommandService } from '../ui-commands/ui-commands.service';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { MailDomainService } from '../mail-engine-admin/mail-domain.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { AgentViewService } from '../agent-view/agent-view.service';
import { MailRulesService } from '../mail-rules/mail-rules.service';
import { TrustedCorrespondentsService } from '../trusted-correspondents/trusted-correspondents.service';
import { enforceMcpToolScope, McpToolName, PatTaggedIdentity } from './mcp-scopes';

const EMAIL_MODE = z.enum(['send', 'draft']);
const INBOX_STATE = z.enum(['pending', 'approved', 'rejected']);
const MAIL_FOLDER = z.enum(['inbox', 'archive', 'spam', 'trash', 'sent', 'drafts']);
const DISPOSITION = z.enum(['INBOX', 'ARCHIVE', 'TRASH', 'SPAM']);

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly membership: MembershipService,
    private readonly email: EmailService,
    private readonly connectedAccounts: ConnectedAccountsService,
    private readonly agents: AgentsService,
    private readonly health: EmailHealthService,
    private readonly policy: ProvisioningPolicyService,
    private readonly mailboxes: MailboxAccountsService,
    private readonly disposition: DispositionService,
    private readonly senderPolicy: SenderPolicyService,
    private readonly uiCommands: UiCommandService,
    private readonly admin: MailEngineAdminPort,
    private readonly mailDomains: MailDomainService,
    private readonly scheduling: SchedulingService,
    private readonly agentView: AgentViewService,
    private readonly mailRules: MailRulesService,
    private readonly trustedCorrespondents: TrustedCorrespondentsService,
  ) {}

  /**
   * Build a fresh MCP server bound to one authenticated user. Returns the server
   * instance; the caller connects a transport to it. The SDK is imported lazily
   * so we pay the resolve cost only when MCP is actually called.
   */
  async createServerForUser(user: User) {
    // Lazy require: the SDK ships dual CJS/ESM; resolve only when MCP is called.
    const sdk = require('@modelcontextprotocol/sdk/server/mcp.js'); // eslint-disable-line @typescript-eslint/no-var-requires
    const McpServer = sdk.McpServer;

    const server = new McpServer(
      {
        name: 'email-ops',
        version: '0.1.0',
      },
      {
        capabilities: { tools: {} },
        instructions:
          'Email-Ops MCP server — the mailbox / thread surface (over the Apache James ' +
          'mail server) + the agent-inbox approval surface of the Unicorn Commander ' +
          'suite. Foundation tools check service health and list the caller’s ' +
          'workspaces. The contract tools let a cockpit (e.g. Customer-Ops) federate ' +
          'mailboxes by workspace: list the threads with a contact, list a thread’s ' +
          'messages (previews only), and compose an outbound email — mode=send queues ' +
          'delivery now (Apache James/Postmark), mode=draft stages it into the AGENT ' +
          'INBOX for a human to approve before it leaves. compose_email is idempotent ' +
          'on (workspace_id, external_source, external_ref) and requires BOTH ' +
          'customer-ops and email-ops entitlements; reading threads is viewer-level. ' +
          'The agent-inbox tools list the pending queue and approve/reject a draft ' +
          '(approve sends it). The connected-accounts tools reflect the caller’s ' +
          'brokered Gmail/Microsoft account links in Keycloak and use the linked ' +
          'provider token to read inbox stats or run inbox analysis through the ' +
          'stateless Cleaner Engine. The cleaner tools are agent-first: plan_cleanup ' +
          'is read-only preview, while clean_trash / clean_delete / organize_messages / ' +
          'unsubscribe_sender stage a pending agent-inbox request instead of executing ' +
          'immediately; a human approval runs the batch. Email-Ops owns the mailboxes, ' +
          'threads, and agent inbox; it federates the Apache James and Cleaner engines and never ' +
          'reinvents either service.',
      },
    );

    // Every MCP handler is registered through this one PAT authorization choke
    // point. JWT identities carry no __patAuth record and pass through unchanged.
    const identity = user as User & PatTaggedIdentity;
    const registerTool = (
      name: McpToolName,
      config: Record<string, unknown>,
      handler: (...args: any[]) => any,
    ) =>
      server.registerTool(name, config, (...args: any[]) => {
        enforceMcpToolScope(identity, name);
        return handler(...args);
      });

    const tools = new EmailOpsTools(
      this.membership,
      this.email,
      this.agents,
      this.health,
      this.policy,
      this.mailboxes,
      this.disposition,
      this.senderPolicy,
      this.admin,
      this.mailDomains,
    );
    const connectedTools = new ConnectedAccountsTools(this.membership, this.connectedAccounts);
    const uiTools = new UiControlTools(this.membership, this.uiCommands);
    const schedulingTools = new SchedulingTools(this.membership, this.scheduling);
    const agentViewTools = new AgentViewTools(this.membership, this.agentView);
    const mailRulesTools = new MailRulesTools(this.membership, this.mailRules);
    const trustedTools = new TrustedCorrespondentTools(this.membership, this.trustedCorrespondents);

    // ── Foundation tools ──

    registerTool(
      'health',
      {
        title: 'Email-Ops health',
        description:
          'Liveness + configuration check. Returns service status, whether suite ' +
          'tenancy is enabled, and the server time.',
        inputSchema: {},
      },
      async () => wrap(tools.health()),
    );

    registerTool(
      'list_my_workspaces',
      {
        title: 'List my workspaces',
        description:
          'Return the workspaces the calling user is an active member of, with their ' +
          'canonical suite role and which one is the default. Empty when the user has ' +
          'no membership.',
        inputSchema: {
          _ack: z.boolean().optional(),
        },
      },
      async () => wrap(await tools.listMyWorkspaces(user)),
    );

    // ── Email-steward tools (a Mail-Ops agent's observability) ──

    registerTool(
      'email_ops_health',
      {
        title: 'Email-Ops health',
        description:
          'The email operations health + setup report for a workspace: is the mail ' +
          'engine configured, the default mailbox + mailbox count, the approval-queue ' +
          'backlog (pending count + oldest age), failed sends in the last 7 days, and the ' +
          'registered agent fleet (count + how many can send autonomously). Read-only — a ' +
          'Mail-Ops steward calls this to know the setup and run health checks.',
        inputSchema: {
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.emailHealth(user, args)),
    );

    registerTool(
      'list_agents',
      {
        title: 'List the agent fleet',
        description:
          'List the workspace’s registered agents (the registry): each agent’s stable ' +
          'key, display name, sending mailbox, autonomy level (L0/L1/L2), and how many of ' +
          'its drafts await approval. Read-only — the fleet roster a Mail-Ops steward reads.',
        inputSchema: {
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.listAgents(user, args)),
    );

    // ── Conversational provisioning (write; runs AS the user, policy-gated) ──

    registerTool(
      'provision_mailbox',
      {
        title: 'Provision a mailbox',
        description:
          'Create a mailbox (human / agent / shared) by talking to an agent. Runs AS the ' +
          'calling user: the workspace provisioning policy is enforced with the user’s own ' +
          'role — so this only does what that user is allowed to. Returns {status:"created", ' +
          'mailbox} when applied, or {status:"pending_approval", request} when the policy ' +
          'requires an approver (a human approves it in the Mailboxes view). owner_kind ' +
          'AGENT is the higher-trust send-identity path (admin by default).',
        inputSchema: {
          workspace_id: z.string().optional(),
          email_address: z.string(),
          display_name: z.string().optional(),
          owner_kind: z.enum(['HUMAN', 'AGENT', 'SHARED']).optional(),
          owner_key: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.provisionMailbox(user, args)),
    );

    registerTool(
      'provision_agent',
      {
        title: 'Provision an agent',
        description:
          'Register a new agent (key + display name + autonomy + tier + manager) by talking ' +
          'to an agent. Runs AS the calling user with their role enforced against the ' +
          'provisioning policy. Returns {status:"created", agent} or {status:"pending_approval", ' +
          'request}. autonomy_level ∈ L0_DRAFT_ONLY|L1_APPROVE_TO_SEND|L2_AUTONOMOUS_AUDIT; tier ' +
          '∈ EXECUTIVE|DOMAIN_LEAD|MANAGER|SPECIALIST|UNSPECIFIED.',
        inputSchema: {
          workspace_id: z.string().optional(),
          key: z.string(),
          display_name: z.string(),
          description: z.string().optional(),
          autonomy_level: z
            .enum(['L0_DRAFT_ONLY', 'L1_APPROVE_TO_SEND', 'L2_AUTONOMOUS_AUDIT'])
            .optional(),
          tier: z
            .enum(['EXECUTIVE', 'DOMAIN_LEAD', 'MANAGER', 'SPECIALIST', 'UNSPECIFIED'])
            .optional(),
          manager_agent_key: z.string().optional(),
          mailbox_account_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.provisionAgent(user, args)),
    );

    // ── Mail triage (write; runs AS the user, member-level) ──

    registerTool(
      'set_disposition',
      {
        title: 'Move a thread to a folder',
        description:
          'Triage a thread into a folder by talking to an agent: INBOX (un-triage), ' +
          'ARCHIVE, TRASH, or SPAM (junk). Runs AS the calling user; only works in a ' +
          'workspace they are a member of. This is the agent analogue of the human ' +
          'triage UI — an agent on a loop can archive handled threads or route junk to ' +
          'Spam. Returns the updated disposition overlay row.',
        inputSchema: {
          workspace_id: z.string().optional(),
          thread_id: z.string(),
          disposition: z.enum(['INBOX', 'ARCHIVE', 'TRASH', 'SPAM']),
        },
      },
      async (args: any) => wrap(await tools.setDisposition(user, args)),
    );

    registerTool(
      'set_sender_policy',
      {
        title: 'Block or trust a sender',
        description:
          'Add/update a sender block (BLOCK) or trust (ALLOW) rule — an exact ADDRESS or ' +
          'a whole DOMAIN. The app enforces it on triage today and feeds it to the mail ' +
          'engine’s inbound spam filter once live (BLOCK → Spam; ALLOW → never-spam). ' +
          'Runs AS the calling user, member-level. Upserts on (scope, pattern).',
        inputSchema: {
          workspace_id: z.string().optional(),
          scope: z.enum(['ADDRESS', 'DOMAIN']).optional(),
          pattern: z.string(),
          kind: z.enum(['BLOCK', 'ALLOW']),
          reason: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.setSenderPolicy(user, args)),
    );

    // ── EmailOpsPort contract tools ──

    registerTool(
      'list_threads_with_contact',
      {
        title: 'List threads with a contact',
        description:
          'List the mailbox THREADS with a customer’s contact (the customer-360 email ' +
          'history). Federated from the Apache James mailbox + the workspace’s own outbound ' +
          'SoR rows, deduped by thread. Read-only / viewer-level — does NOT require the ' +
          'dual SKU. Returns { threads: [...] }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          contact_id: z.string(),
        },
      },
      async (args: any) => wrap(await tools.listThreadsWithContact(user, args)),
    );

    registerTool(
      'list_thread_messages',
      {
        title: 'List thread messages',
        description:
          'List the MESSAGES in one thread, bodies as PREVIEWS only (the full message ' +
          'lives in Apache James). Read-only / viewer-level. Returns { messages: [...] }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          thread_id: z.string(),
        },
      },
      async (args: any) => wrap(await tools.listThreadMessages(user, args)),
    );

    registerTool(
      'compose_email',
      {
        title: 'Compose an outbound email',
        description:
          'Compose an outbound email to a customer’s contact. mode=send queues delivery ' +
          'now (Apache James, or Postmark for the transactional high-rep lane); mode=draft ' +
          'stages it into the AGENT INBOX approval surface (a human approves before it ' +
          'leaves — the safe default for an agent). IDEMPOTENT on (workspace_id, ' +
          'external_source, external_ref): a repeat returns the EXISTING message and ' +
          'queues NO second send. Requires BOTH customer-ops and email-ops entitlements. ' +
          'Email-Ops stores no contact record (contact_id is a thin reference) and is ' +
          'the system-of-record for the message it created.',
        inputSchema: {
          workspace_id: z.string().optional(),
          contact_id: z.string().optional(),
          to_address: z.string().min(1).max(320),
          subject: z.string().min(1).max(500),
          body: z.string().min(1).max(100000),
          mode: EMAIL_MODE.optional(),
          in_reply_to_thread_id: z.string().max(200).optional(),
          external_source: z.string().min(1).max(64),
          external_ref: z.string().min(1).max(256),
        },
      },
      async (args: any) => wrap(await tools.composeEmail(user, args)),
    );

    // ── Mail read plane (agent list/search/read + read-state/bulk triage) ──
    // The agents' READ surface over their own mailboxes: list/search threads, read
    // a thread's full messages, mark read/unread, and bulk-triage into folders.
    // Thin wrappers over the SAME EmailService/DispositionService methods the human
    // mail BFF uses — one RLS path, degrade-clean (reads → [] when the engine is
    // dormant). Reads are read_only; set_read + bulk_disposition are member writes.

    registerTool(
      'list_threads',
      {
        title: 'List mailbox threads',
        description:
          'List the THREADS in a mailbox folder (inbox/archive/spam/trash/sent/drafts). ' +
          'Pass mailbox_id for ONE mailbox; omit it for the UNIFIED inbox across every ' +
          'mailbox the caller can read (each thread then carries mailbox_id + ' +
          'mailbox_address). Optional q (full-text), limit (≤200, default 50), offset ' +
          '(paging). Read-only / member-level. Returns { threads, count, folder } — an ' +
          'empty list when the mail engine is dormant (never a 500).',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().optional(),
          folder: MAIL_FOLDER.optional(),
          q: z.string().max(500).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).optional(),
        },
      },
      async (args: any) => wrap(await tools.listThreads(user, args ?? {})),
    );

    registerTool(
      'get_thread',
      {
        title: 'Get a thread with bodies',
        description:
          'Return the full MESSAGES in one thread WITH bodies (text + HTML), cc/bcc, ' +
          'threading headers, read/flag state, and attachments when the engine serves ' +
          'them. Pass mailbox_id to read an external (Gmail/Microsoft) thread through its ' +
          'provider or to force the live engine detail; omit it to read the workspace ' +
          'default mailbox. Read-only / member-level. Returns { messages, count }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          thread_id: z.string().min(1),
          mailbox_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.getThread(user, args)),
    );

    registerTool(
      'search_mail',
      {
        title: 'Search mail',
        description:
          'Full-text SEARCH a mailbox folder by query string q (subject/body/participants, ' +
          'via the engine’s own search). Pass mailbox_id for ONE mailbox; omit it to search ' +
          'across every readable mailbox (unified). Optional folder (default inbox), limit ' +
          '(≤200, default 50), offset. Read-only / member-level. Returns { threads, count, ' +
          'q } — an empty list when the engine is dormant.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().optional(),
          q: z.string().min(1).max(500),
          folder: MAIL_FOLDER.optional(),
          limit: z.number().int().min(1).max(200).optional(),
          offset: z.number().int().min(0).optional(),
        },
      },
      async (args: any) => wrap(await tools.searchMail(user, args)),
    );

    registerTool(
      'set_read',
      {
        title: 'Mark a thread read/unread',
        description:
          'Set or clear the read ($seen) state on every message in a thread. Pass ' +
          'mailbox_id to target ONE mailbox; omit it to apply across the workspace’s ' +
          'sovereign mailboxes (the bulk path). Member-level write; runs AS the calling ' +
          'user. Returns { thread_id, read, updated } — updated:false when the engine ' +
          'could not apply it (e.g. dormant, or an external provider mailbox).',
        inputSchema: {
          workspace_id: z.string().optional(),
          thread_id: z.string().min(1),
          read: z.boolean(),
          mailbox_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.setRead(user, args)),
    );

    registerTool(
      'bulk_disposition',
      {
        title: 'Bulk-triage threads into a folder',
        description:
          'Move a SET of threads into a folder in one call: ARCHIVE, TRASH, SPAM, or INBOX ' +
          '(un-triage) — the SAME disposition overlay the single-thread set_disposition ' +
          'writes. Per-thread isolation: one failing thread never fails the batch. ' +
          'Member-level write; runs AS the calling user. Returns { succeeded, failed } ' +
          '(thread ids). Up to 200 thread_ids per call.',
        inputSchema: {
          workspace_id: z.string().optional(),
          thread_ids: z.array(z.string().min(1)).min(1).max(200),
          disposition: DISPOSITION,
        },
      },
      async (args: any) => wrap(await tools.bulkDisposition(user, args)),
    );

    // ── Custom folders / labels (per-mailbox, James JMAP) ──
    // The agent's folder rail: list, create, rename, delete custom folders.
    // Member-level; degrade-clean (dormant/external mailbox → []/false).

    registerTool(
      'list_folders',
      {
        title: 'List mailbox folders',
        description:
          'List every folder in a mailbox — the system role folders (Inbox/Sent/Archive/' +
          'Trash/Junk/Drafts, role non-null) AND user-created custom folders (role null). ' +
          'Read-only / member-level. Returns { folders: [{ id, name, role, parentId, ' +
          'unread? }], count } — an empty list when the engine is dormant or the mailbox is ' +
          'external.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await tools.listFolders(user, args)),
    );

    registerTool(
      'create_folder',
      {
        title: 'Create a custom folder',
        description:
          'Create a custom folder in a mailbox, optionally nested under parent_id. ' +
          'Member-level write. Returns { id, created } — created:false when the engine ' +
          'is dormant or the mailbox is external (no throw).',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          name: z.string().min(1).max(200),
          parent_id: z.string().max(500).optional(),
        },
      },
      async (args: any) => wrap(await tools.createFolder(user, args)),
    );

    registerTool(
      'rename_folder',
      {
        title: 'Rename a custom folder',
        description:
          'Rename a folder by id. Member-level write. Returns { updated } — updated:false ' +
          'when the id is unknown, the engine is dormant, or the mailbox is external.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          folder_id: z.string().min(1),
          name: z.string().min(1).max(200),
        },
      },
      async (args: any) => wrap(await tools.renameFolder(user, args)),
    );

    registerTool(
      'delete_folder',
      {
        title: 'Delete a custom folder',
        description:
          'Delete a CUSTOM folder by id. A system/role folder (Inbox/Sent/Archive/Trash/' +
          'Junk/Drafts) is NEVER deletable — the engine refuses it. Member-level write. ' +
          'Returns { deleted } — deleted:false when refused, unknown, dormant, or external.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          folder_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await tools.deleteFolder(user, args)),
    );

    registerTool(
      'move_to_folder',
      {
        title: 'Move a thread into a custom folder',
        description:
          'Move a thread INTO a custom folder by folder_id (from list_folders). This is ' +
          'the custom-folder counterpart to bulk_disposition (which reaches only the ' +
          'system folders). Member-level write. Returns { moved } — moved:false when the ' +
          'target/thread is unknown, the mailbox is external, or the engine is dormant.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          thread_id: z.string().min(1),
          folder_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await tools.moveToFolder(user, args)),
    );

    // ── Connected-accounts / Cleaner Engine tools ──

    registerTool(
      'list_connected_accounts',
      {
        title: 'List connected accounts',
        description:
          'List whether the caller has linked Gmail or Microsoft in Keycloak. ' +
          'Viewer-level; no SKU gate. Returns { accounts: [{ provider, linked }] }.',
        inputSchema: {
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await connectedTools.listConnectedAccounts(user, args ?? {})),
    );

    registerTool(
      'get_inbox_stats',
      {
        title: 'Get inbox stats',
        description:
          'Return Cleaner Engine inbox stats using the caller’s brokered provider ' +
          'token. Requires the email-ops SKU.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
        },
      },
      async (args: any) => wrap(await connectedTools.getInboxStats(user, args)),
    );

    registerTool(
      'analyze_inbox',
      {
        title: 'Analyze inbox',
        description:
          'Run the stateless Cleaner Engine analysis using the caller’s brokered ' +
          'provider token. Requires the email-ops SKU.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
        },
      },
      async (args: any) => wrap(await connectedTools.analyzeInbox(user, args)),
    );

    registerTool(
      'plan_cleanup',
      {
        title: 'Plan cleanup',
        description:
          'Build a dry-run cleanup plan with protected and safe rows separated. Read-only preview; does not mutate the mailbox.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
          criteria: z.record(z.unknown()).optional(),
        },
      },
      async (args: any) => wrap(await connectedTools.planCleanup(user, args)),
    );

    registerTool(
      'clean_trash',
      {
        title: 'Trash cleanup batch',
        description:
          'Stage a trash cleanup batch into the agent inbox. The caller is an agent, so this does not execute immediately.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
          criteria: z.record(z.unknown()).optional(),
        },
      },
      async (args: any) => wrap(await connectedTools.cleanTrash(user, args)),
    );

    registerTool(
      'clean_delete',
      {
        title: 'Delete cleanup batch',
        description:
          'Stage a permanent-delete cleanup batch into the agent inbox. Human approval later enforces the verified-backup gate.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
          criteria: z.record(z.unknown()).optional(),
        },
      },
      async (args: any) => wrap(await connectedTools.cleanDelete(user, args)),
    );

    registerTool(
      'organize_messages',
      {
        title: 'Organize messages',
        description:
          'Stage an organize/archive batch into the agent inbox. This is a pending approval request for an agent caller.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
          criteria: z.record(z.unknown()).optional(),
        },
      },
      async (args: any) => wrap(await connectedTools.organizeMessages(user, args)),
    );

    registerTool(
      'unsubscribe_sender',
      {
        title: 'Unsubscribe sender group',
        description:
          'Stage an unsubscribe batch into the agent inbox for a sender group. Approval later decides whether it executes.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
          sender_group: z.array(z.string()),
        },
      },
      async (args: any) => wrap(await connectedTools.unsubscribeSender(user, args)),
    );

    registerTool(
      'undo_batch',
      {
        title: 'Undo cleanup batch',
        description:
          'Undo a cleanup batch record. This is a best-effort audit reversal and does not invent a restore path the engine does not expose.',
        inputSchema: {
          workspace_id: z.string().optional(),
          provider: z.enum(['gmail', 'microsoft']),
          batch_id: z.string(),
        },
      },
      async (args: any) => wrap(await connectedTools.undoBatch(user, args)),
    );

    // ── Agent-inbox approval tools ──

    registerTool(
      'list_agent_inbox',
      {
        title: 'List the agent inbox',
        description:
          'List the agent-inbox queue: agent-drafted messages awaiting human approval ' +
          'before send (mode=draft composes land here). Defaults to PENDING; pass state ' +
          'to filter. Returns { items: [...], count }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          state: INBOX_STATE.optional(),
        },
      },
      async (args: any) => wrap(await tools.listAgentInbox(user, args ?? {})),
    );

    registerTool(
      'approve_agent_inbox_item',
      {
        title: 'Approve an agent-inbox draft (sends it)',
        description:
          'Approve a PENDING agent-inbox draft: hand it to the send lane and advance the ' +
          'message to queued/sent. This is the human-in-the-loop SEND, so it requires ' +
          'BOTH customer-ops and email-ops entitlements. By default the approval also ' +
          'TRUSTS the external recipients (Wave 7 learning) so future in-thread agent ' +
          'replies to them can send autonomously; pass trust_recipients:false to approve ' +
          'without learning. Returns the updated inbox item + message.',
        inputSchema: {
          workspace_id: z.string().optional(),
          item_id: z.string(),
          note: z.string().max(2000).optional(),
          // Wave 7 learning: default TRUE — the approval trusts the external
          // recipients; pass false to approve without learning.
          trust_recipients: z.boolean().optional(),
        },
      },
      async (args: any) => wrap(await tools.approveAgentInboxItem(user, args)),
    );

    registerTool(
      'reject_agent_inbox_item',
      {
        title: 'Reject an agent-inbox draft',
        description:
          'Reject a PENDING agent-inbox draft: mark it REJECTED; the message is never ' +
          'sent. Returns the updated inbox item + message.',
        inputSchema: {
          workspace_id: z.string().optional(),
          item_id: z.string(),
          note: z.string().max(2000).optional(),
        },
      },
      async (args: any) => wrap(await tools.rejectAgentInboxItem(user, args)),
    );

    // ── Trusted-correspondent tools (Wave 7: the outbound trust allowlist) ──

    registerTool(
      'list_trusted_correspondents',
      {
        title: 'List trusted correspondents',
        description:
          'List the workspace’s trusted correspondents — the OUTBOUND addresses an ' +
          'L2 agent may auto-send to (learned when a human approves a staged draft, ' +
          'or added manually). Read-only / member-level. Returns { items, count }.',
        inputSchema: {
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await trustedTools.listTrustedCorrespondents(user, args ?? {})),
    );

    registerTool(
      'trust_correspondent',
      {
        title: 'Trust a correspondent',
        description:
          'Manually add an address (jane@acme.com) OR a whole domain (acme.com) to ' +
          'the trusted-correspondent allowlist (source MANUAL; idempotent — ' +
          're-trusting refreshes the note). scope is inferred from the value when ' +
          'omitted (an "@"-address → address; a bare domain → domain). After this, ' +
          'an L2 agent’s in-thread replies to the address (or any address at the ' +
          'trusted domain) can send autonomously. Returns the trusted-correspondent row.',
        inputSchema: {
          workspace_id: z.string().optional(),
          address: z.string().min(3).max(320),
          note: z.string().max(500).optional(),
          scope: z.enum(['address', 'domain']).optional(),
        },
      },
      async (args: any) => wrap(await trustedTools.trustCorrespondent(user, args)),
    );

    registerTool(
      'untrust_correspondent',
      {
        title: 'Untrust a correspondent',
        description:
          'Remove an address from the trusted-correspondent allowlist — the next ' +
          'agent reply to it stages for human approval again. Returns { ok } ' +
          '(ok:false when the address was not trusted).',
        inputSchema: {
          workspace_id: z.string().optional(),
          address: z.string().min(3).max(320),
        },
      },
      async (args: any) => wrap(await trustedTools.untrustCorrespondent(user, args)),
    );

    // ── Mail-engine admin tools (control-plane; OWNER-gated writes) ──

    registerTool(
      'list_mail_domains',
      {
        title: 'List mail engine domains',
        description:
          'List only the caller workspace’s bound domains that the sovereign mail engine ' +
          '(Apache James) currently serves. Read-only / member-level. Returns ' +
          '{ domains: [{ domain }] } or ' +
          '{ status:"engine_not_configured" } when no WebAdmin endpoint is wired.',
        inputSchema: {
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.listMailDomains(user, args ?? {})),
    );

    registerTool(
      'list_mail_accounts',
      {
        title: 'List mail engine accounts',
        description:
          'List only engine accounts (mailbox logins) under the caller workspace’s bound ' +
          'domains. Read-only / member-level. Returns { accounts: [{ address }] } or ' +
          '{ status:"engine_not_configured" } when no WebAdmin endpoint is wired.',
        inputSchema: {
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await tools.listMailAccounts(user, args ?? {})),
    );

    registerTool(
      'ensure_mail_domain',
      {
        title: 'Ensure a domain on the mail engine',
        description:
          'Claim a domain for the caller workspace, then add it to the mail engine if it ' +
          'is not already served (idempotent). A domain claimed by another workspace ' +
          'returns a conflict. OWNER-only — returns { status:"forbidden" } for any lower role. ' +
          'Returns { status:"ok"|"failed"|"engine_not_configured", result }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          domain: z.string().min(1).max(253),
        },
      },
      async (args: any) => wrap(await tools.ensureMailDomain(user, args)),
    );

    registerTool(
      'remove_mail_domain',
      {
        title: 'Remove a domain from the mail engine',
        description:
          'Remove a domain from the mail engine (idempotent). OWNER-only. ' +
          'The domain must already be bound to the caller workspace. ' +
          'Call only when you are certain no active accounts remain under this domain. ' +
          'Returns { status:"ok"|"failed"|"engine_not_configured", result }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          domain: z.string().min(1).max(253),
        },
      },
      async (args: any) => wrap(await tools.removeMailDomain(user, args)),
    );

    registerTool(
      'set_mailbox_quota',
      {
        title: 'Set mailbox storage quota',
        description:
          'Set (or clear) the storage quota for an engine mailbox account. OWNER-only. ' +
          'The address domain must be bound to the caller workspace. ' +
          'quota_bytes defaults to 5368709120 bytes (5 GiB); pass null ' +
          'to remove the quota limit entirely. Returns ' +
          '{ status:"ok"|"failed"|"engine_not_configured", result }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          address: z.string().email(),
          quota_bytes: z.number().int().nonnegative().nullable().optional(),
        },
      },
      async (args: any) => wrap(await tools.setMailboxQuota(user, args)),
    );

    registerTool(
      'remove_mailbox_engine',
      {
        title: 'Remove engine mailbox account',
        description:
          'Remove the mail-server account for an address (idempotent). OWNER-only. ' +
          'The address domain must be bound to the caller workspace. ' +
          'Tears down the engine login and storage ONLY — does NOT delete the SoR ' +
          'MailboxAccount row or stored message records. Use for clean-ups after the ' +
          'SoR row has already been deleted or when re-provisioning from scratch. ' +
          'Returns { status:"ok"|"failed"|"engine_not_configured", result }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          address: z.string().email(),
        },
      },
      async (args: any) => wrap(await tools.removeMailboxEngine(user, args)),
    );

    // ── UI-control tools (the "agent controls the UI" / AG-UI surface) ──
    // Each enqueues a command the caller's OPEN cockpit drains + applies. No
    // external side effect → member-level, NOT routed through the compose
    // autonomy / agent-inbox gate. ui_compose only PREFILLS (the human sends).

    registerTool(
      'ui_navigate',
      {
        title: 'Navigate the user’s cockpit',
        description:
          'Push a NAVIGATE command to the calling user’s open Email-Ops cockpit: route it ' +
          'to an app path (e.g. /mail, /agents, /agent-inbox, /cleanup, /dashboard, ' +
          '/insights, /mailboxes, /accounts). Applied on the user’s next focus-gated poll. ' +
          'No side effect. Returns { enqueued, command_id, kind }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          // Internal app route ONLY — a single leading "/", not "//" or "/\" (which
          // resolve off-origin) and no scheme (e.g. javascript:). This is the
          // server-side half of the open-redirect / DOM-XSS guard; the cockpit
          // re-validates before navigating (defense in depth).
          path: z
            .string()
            .min(1)
            .max(512)
            .refine((p) => /^\/(?![/\\])/.test(p.replace(/[\t\n\r]/g, '')), {
              message: 'path must be an internal app route starting with a single "/".',
            }),
        },
      },
      async (args: any) => wrap(await uiTools.navigate(user, args)),
    );

    registerTool(
      'ui_open_thread',
      {
        title: 'Open a mail thread in the cockpit',
        description:
          'Push an OPEN_THREAD command: navigate the user’s cockpit to /mail and select a ' +
          'specific thread (optionally selecting its mailbox first). Read-only UI action. ' +
          'Returns { enqueued, command_id, kind }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().optional(),
          thread_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await uiTools.openThread(user, args)),
    );

    registerTool(
      'ui_compose',
      {
        title: 'Pre-fill the composer (does NOT send)',
        description:
          'Push a COMPOSE command that opens the cockpit composer PRE-FILLED with an ' +
          'optional to / subject / body (and optional thread to reply in). It does NOT ' +
          'send — the human reviews and sends. Use compose_email instead to actually ' +
          'queue/stage an outbound message. Returns { enqueued, command_id, kind }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          to: z.string().max(320).optional(),
          subject: z.string().max(500).optional(),
          body: z.string().max(100000).optional(),
          thread_id: z.string().max(200).optional(),
        },
      },
      async (args: any) => wrap(await uiTools.compose(user, args)),
    );

    registerTool(
      'ui_switch_space',
      {
        title: 'Switch the active Space',
        description:
          'Push a SWITCH_SPACE command: set the cockpit’s active Space (a Space id, or ' +
          '"all" for no filter), which re-scopes /mail + the agents view. Returns ' +
          '{ enqueued, command_id, kind }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          space_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await uiTools.switchSpace(user, args)),
    );

    registerTool(
      'ui_notify',
      {
        title: 'Show a toast in the cockpit',
        description:
          'Push a NOTIFY command: show a non-blocking toast in the user’s cockpit — an ' +
          'agent → human status message (e.g. "Archived 12 newsletters"). tone ∈ ' +
          'info|success|warning. Returns { enqueued, command_id, kind }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          title: z.string().min(1).max(200),
          body: z.string().max(2000).optional(),
          tone: z.enum(['info', 'success', 'warning']).optional(),
        },
      },
      async (args: any) => wrap(await uiTools.notify(user, args)),
    );

    // ── Scheduling (snooze / send-later) ──
    // The agent analogue of the human snooze + send-later REST routes
    // (scheduling.controller.ts). Thin wrappers over the SAME SchedulingService;
    // member-level, runs AS the caller, degrade-clean (false/[] when the sovereign
    // mailbox is dormant or external). Reads are read_only; the rest are writes.

    registerTool(
      'snooze_thread',
      {
        title: 'Snooze a thread until a time',
        description:
          'Snooze a thread in a sovereign mailbox until a chosen time (ISO 8601 until): it ' +
          'leaves the Inbox now and the scheduler wakes it back to Inbox at that time. ' +
          'Member-level write; runs AS the calling user. Returns { snoozed, item } — ' +
          'snoozed:false when the mailbox is dormant or external, or the move was refused.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          thread_id: z.string().min(1),
          until: z.string().min(1),
        },
      },
      async (args: any) => wrap(await schedulingTools.snoozeThread(user, args)),
    );

    registerTool(
      'unsnooze_thread',
      {
        title: 'Cancel a thread snooze',
        description:
          'Cancel an active snooze and restore the thread to Inbox immediately. Member-level ' +
          'write; runs AS the calling user. Returns { unsnoozed } — unsnoozed:false when no ' +
          'active snooze matches the thread or the mailbox is dormant or external.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          thread_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await schedulingTools.unsnoozeThread(user, args)),
    );

    registerTool(
      'list_snoozed',
      {
        title: 'List snoozed threads',
        description:
          'List the active snoozed threads for one sovereign mailbox, each with its wake ' +
          'time. Read-only / member-level. Returns { snoozed, count } — an empty list when ' +
          'the mailbox is dormant or external.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await schedulingTools.listSnoozed(user, args)),
    );

    registerTool(
      'schedule_send',
      {
        title: 'Schedule an email to send later',
        description:
          'Schedule an outbound email to send later (ISO 8601 send_at) from one sovereign ' +
          'mailbox. The scheduler fires it at send_at through the same send lane compose_email ' +
          'uses, idempotent on the scheduled-send id so a retry never doubles. Member-level ' +
          'write; runs AS the calling user. Returns { scheduled, item } — scheduled:false when ' +
          'the mailbox is dormant or external.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          to_address: z.string().min(1).max(320),
          subject: z.string().max(500).optional(),
          body: z.string().max(100000).optional(),
          body_html: z.string().max(100000).optional(),
          to_addresses: z.array(z.string()).max(50).optional(),
          cc: z.array(z.string()).max(50).optional(),
          bcc: z.array(z.string()).max(50).optional(),
          in_reply_to_thread_id: z.string().max(500).optional(),
          send_at: z.string().min(1),
        },
      },
      async (args: any) => wrap(await schedulingTools.scheduleSend(user, args)),
    );

    registerTool(
      'cancel_scheduled_send',
      {
        title: 'Cancel a scheduled send',
        description:
          'Cancel a pending scheduled send by id before it fires. Member-level write; runs AS ' +
          'the calling user. Returns { cancelled } — cancelled:false when the id is unknown, ' +
          'already sent or cancelled, or the owning mailbox is not actionable.',
        inputSchema: {
          workspace_id: z.string().optional(),
          id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await schedulingTools.cancelScheduledSend(user, args)),
    );

    registerTool(
      'list_scheduled_sends',
      {
        title: 'List scheduled sends',
        description:
          'List the pending (and in-flight) scheduled sends for one sovereign mailbox, each ' +
          'with its send time and payload. Read-only / member-level. Returns ' +
          '{ scheduled_sends, count } — an empty list when the mailbox is dormant or external.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await schedulingTools.listScheduledSends(user, args)),
    );

    // ── Agent-view (per-agent mailbox) ──
    // The agent analogue of the per-agent mailbox REST routes
    // (agent-view.controller.ts): the roster + one agent's mailbox world. Read-only,
    // member-level, over the SAME AgentViewService the human cockpit uses.

    registerTool(
      'list_agent_mailboxes',
      {
        title: 'List per-agent mailboxes',
        description:
          'List the workspace’s agents with their mailbox address, unread count, and ' +
          'pending-approval count — the lightweight roster behind the agent-world switcher. ' +
          'Read-only / member-level. Returns { items, count }.',
        inputSchema: {
          workspace_id: z.string().optional(),
        },
      },
      async (args: any) => wrap(await agentViewTools.listAgentMailboxes(user, args ?? {})),
    );

    registerTool(
      'get_agent_mailbox',
      {
        title: 'Get one agent’s mailbox',
        description:
          'Return one agent’s mailbox world: its mailbox, recent inbox threads (up to ' +
          'thread_limit, default 25, max 100), its pending agent-inbox drafts + state counts, ' +
          'and mailbox stats. Read-only / member-level. Returns the composed view, or ' +
          '{ status:"not_found" } when no such agent exists in this workspace.',
        inputSchema: {
          workspace_id: z.string().optional(),
          agent_id: z.string().min(1),
          thread_limit: z.number().int().min(1).max(100).optional(),
        },
      },
      async (args: any) => wrap(await agentViewTools.getAgentMailbox(user, args)),
    );

    // ── Mail rules (per-mailbox inbound filters) ──
    // The agent analogue of the human rules-management REST routes
    // (mail-rules.controller.ts): CRUD over one mailbox's inbound rules. Thin
    // wrappers over the SAME MailRulesService — one implementation, one RLS path;
    // the per-mailbox tenant fence + sovereign-owner check and ALL match/actions
    // validation live in the service (a bad payload surfaces as its own
    // BadRequestException, exactly as on REST). list is read_only; the rest are
    // member-level writes.

    registerTool(
      'list_mail_rules',
      {
        title: 'List mail rules',
        description:
          'List one mailbox’s inbound mail rules, priority ascending: each rule’s name, ' +
          'enabled state, priority, match tree, ordered actions, and hit stats. ' +
          'Read-only / member-level. Returns { rules, count }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await mailRulesTools.listMailRules(user, args)),
    );

    registerTool(
      'create_mail_rule',
      {
        title: 'Create a mail rule',
        description:
          'Create an inbound rule on one mailbox: a name, a match tree ({ all / any } ' +
          'groups of { field, op, value } conditions over from/to/subject/fromDomain), ' +
          'and an ordered actions list (MOVE_TO_FOLDER/ARCHIVE/TRASH/MARK_READ/STOP). ' +
          'priority auto-assigns past the current max when omitted. The service validates ' +
          'match + actions exactly as on REST — a bad payload is refused, never stored ' +
          'raw. Member-level write; runs AS the calling user. Returns the created rule.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          name: z.string().min(1).max(120),
          // match/actions are rule-engine JSON; zod pins only the container types —
          // the service is the real validator (parseMatch/parseActions + policy
          // checks), exactly as on the REST DTO.
          match: z.record(z.unknown()),
          actions: z.array(z.unknown()),
          enabled: z.boolean().optional(),
          priority: z.number().int().optional(),
        },
      },
      async (args: any) => wrap(await mailRulesTools.createMailRule(user, args)),
    );

    registerTool(
      'update_mail_rule',
      {
        title: 'Update a mail rule',
        description:
          'Update any subset of an inbound rule’s fields (name, enabled, priority, ' +
          'match, actions); provided fields are re-validated exactly as on create. ' +
          'Member-level write; runs AS the calling user. Returns the updated rule, or ' +
          '{ status:"not_found" } when the rule is not in this workspace + mailbox.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          rule_id: z.string().min(1),
          name: z.string().min(1).max(120).optional(),
          match: z.record(z.unknown()).optional(),
          actions: z.array(z.unknown()).optional(),
          enabled: z.boolean().optional(),
          priority: z.number().int().optional(),
        },
      },
      async (args: any) => wrap(await mailRulesTools.updateMailRule(user, args)),
    );

    registerTool(
      'delete_mail_rule',
      {
        title: 'Delete a mail rule',
        description:
          'Delete an inbound rule from one mailbox. Member-level write; runs AS the ' +
          'calling user. Returns { ok:true }, or { ok:false, reason } when the rule is ' +
          'not in this workspace + mailbox.',
        inputSchema: {
          workspace_id: z.string().optional(),
          mailbox_id: z.string().min(1),
          rule_id: z.string().min(1),
        },
      },
      async (args: any) => wrap(await mailRulesTools.deleteMailRule(user, args)),
    );

    return server;
  }
}

/**
 * Wrap a tool payload for the MCP transport. We return BOTH `structuredContent`
 * (the cockpit's federation client reads result.structuredContent FIRST) AND a
 * text content block (the fallback the client parses if structuredContent is
 * absent), so the EmailOpsPort seam maps either way.
 */
function wrap(payload: unknown) {
  return {
    structuredContent: payload as Record<string, unknown>,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
