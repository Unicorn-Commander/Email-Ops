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
import { ConnectedAccountsTools, EmailOpsTools } from './mcp.tools';
import { AgentsService } from '../agents/agents.service';
import { EmailHealthService } from '../email-health/email-health.service';

const EMAIL_MODE = z.enum(['send', 'draft']);
const INBOX_STATE = z.enum(['pending', 'approved', 'rejected']);

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly membership: MembershipService,
    private readonly email: EmailService,
    private readonly connectedAccounts: ConnectedAccountsService,
    private readonly agents: AgentsService,
    private readonly health: EmailHealthService,
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
          'Email-Ops MCP server — the mailbox / thread surface (over the Stalwart ' +
          'mail server) + the agent-inbox approval surface of the Unicorn Commander ' +
          'suite. Foundation tools check service health and list the caller’s ' +
          'workspaces. The contract tools let a cockpit (e.g. Customer-Ops) federate ' +
          'mailboxes by workspace: list the threads with a contact, list a thread’s ' +
          'messages (previews only), and compose an outbound email — mode=send queues ' +
          'delivery now (Stalwart/Postmark), mode=draft stages it into the AGENT ' +
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
          'threads, and agent inbox; it federates the Stalwart and Cleaner engines and never ' +
          'reinvents either service.',
      },
    );

    const tools = new EmailOpsTools(this.membership, this.email, this.agents, this.health);
    const connectedTools = new ConnectedAccountsTools(this.membership, this.connectedAccounts);

    // ── Foundation tools ──

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    // ── EmailOpsPort contract tools ──

    server.registerTool(
      'list_threads_with_contact',
      {
        title: 'List threads with a contact',
        description:
          'List the mailbox THREADS with a customer’s contact (the customer-360 email ' +
          'history). Federated from the Stalwart mailbox + the workspace’s own outbound ' +
          'SoR rows, deduped by thread. Read-only / viewer-level — does NOT require the ' +
          'dual SKU. Returns { threads: [...] }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          contact_id: z.string(),
        },
      },
      async (args: any) => wrap(await tools.listThreadsWithContact(user, args)),
    );

    server.registerTool(
      'list_thread_messages',
      {
        title: 'List thread messages',
        description:
          'List the MESSAGES in one thread, bodies as PREVIEWS only (the full message ' +
          'lives in Stalwart). Read-only / viewer-level. Returns { messages: [...] }.',
        inputSchema: {
          workspace_id: z.string().optional(),
          thread_id: z.string(),
        },
      },
      async (args: any) => wrap(await tools.listThreadMessages(user, args)),
    );

    server.registerTool(
      'compose_email',
      {
        title: 'Compose an outbound email',
        description:
          'Compose an outbound email to a customer’s contact. mode=send queues delivery ' +
          'now (Stalwart, or Postmark for the transactional high-rep lane); mode=draft ' +
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

    // ── Connected-accounts / Cleaner Engine tools ──

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
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

    server.registerTool(
      'approve_agent_inbox_item',
      {
        title: 'Approve an agent-inbox draft (sends it)',
        description:
          'Approve a PENDING agent-inbox draft: hand it to the send lane and advance the ' +
          'message to queued/sent. This is the human-in-the-loop SEND, so it requires ' +
          'BOTH customer-ops and email-ops entitlements. Returns the updated inbox item ' +
          '+ message.',
        inputSchema: {
          workspace_id: z.string().optional(),
          item_id: z.string(),
          note: z.string().max(2000).optional(),
        },
      },
      async (args: any) => wrap(await tools.approveAgentInboxItem(user, args)),
    );

    server.registerTool(
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
