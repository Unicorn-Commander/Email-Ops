/**
 * EmailService — the Email-Ops system-of-record + the EmailOpsPort contract +
 * the agent-inbox approval flow.
 *
 * This is the ONE implementation both the MCP contract tools and (future) REST
 * surface delegate to, so an agent and a human hit one set of rules + one RLS
 * path. Every method runs inside `withWorkspace(workspaceId, ucUid, …)` — the
 * GUC chokepoint — so Postgres RLS scopes every row to the workspace the moment
 * the runtime flips to the NOBYPASSRLS email_ops_app role. The mailbox engine is
 * the injected StalwartPort (degrade-clean): reads federate Stalwart; sends route
 * Stalwart/Postmark; nothing throws when the engine is unconfigured.
 *
 * The three contract behaviors (matching Customer-Ops' EmailOpsPort):
 *   1. listThreadsWithContact — the live mailbox threads with a contact
 *      (federated from Stalwart) UNION the workspace's own outbound thread rows
 *      (the SoR), deduped by thread id. Read-only / viewer-level.
 *   2. listThreadMessages — the messages in a thread (Stalwart previews UNION
 *      the SoR outbound rows). Read-only / viewer-level.
 *   3. composeEmail — IDEMPOTENT on (workspaceId, externalSource, externalRef):
 *        - mode=send  → record the SoR row, hand to the mail engine, set status
 *          from the engine result (queued/sent/failed).
 *        - mode=draft → record the SoR row in status PENDING_APPROVAL and stage
 *          an AgentInboxItem (PENDING). The send happens later on approve().
 *      A repeat with the same tuple returns the EXISTING message, queues NO
 *      second send.
 *
 * The agent-inbox approval flow:
 *   - listAgentInbox(state?) — the queue (pending by default).
 *   - approveAgentInboxItem — PENDING → APPROVED, hand the staged draft to the
 *     send lane, advance the message to queued/sent/failed.
 *   - rejectAgentInboxItem  — PENDING → REJECTED; the message is marked REJECTED
 *     and never leaves.
 */

import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  AgentActionKind,
  AgentInboxKind,
  AgentInboxState,
  EmailDirection,
  EmailMessageStatus,
  EmailMode,
  MailboxAccount,
  MessageDisposition,
  Prisma,
  TrustedCorrespondentSource,
  TrustedCorrespondentScope,
} from '@prisma/client';
import { ConnectedAccountsService } from '../connected-accounts/connected-accounts.service';
import { MAX_TARGET_ROWS } from '../connected-accounts/cleanup-targets';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartDraftRequest, StalwartMailFolder, StalwartMessageDetail, StalwartThread } from '../stalwart/stalwart.types';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import {
  AGENT_REPLY_RUNTIME_SOURCE,
  AgentInboxDetailView,
  AgentInboxView,
  AttachmentView,
  AutoSentItemView,
  BulkActionResult,
  ComposeInput,
  EngagementCaptureInput,
  EngagementCaptureResult,
  MailboxCountsView,
  MailFolder,
  MessageComposeView,
  MessageFullView,
  MessageView,
  ParticipantView,
  ThreadView,
} from './email.types';
import { shouldAdvanceStatus } from './message-status';
import { DispositionView } from '../mail-triage/mail-triage.types';
import {
  AgentComposeContext,
  decideAgentComposeMode,
  isExternalRecipient,
  MailboxClass,
  normalizeAddress,
  parseRecipientPolicy,
  PolicyReason,
  splitRecipients,
} from './autonomy';
import { mapWithConcurrency, withTimeout } from '../common/async/concurrency';
import { ApprovalPendingNotice, StableNotifierService } from '../notify/stable-notifier.service';

/**
 * Fan-out bounds for the multi-mailbox webmail endpoints (unified inbox +
 * counts). With ~10 mailboxes — several slow external providers — an unbounded
 * fan-out both hammers the engines and blocks on the slowest one.
 *   • CONCURRENCY caps how many mailbox reads run at once.
 *   • TIMEOUT caps how long any ONE mailbox may take before it's treated as a
 *     failed slot (omitted from the aggregate / error:true in counts) so a
 *     wedged provider can never stall the whole response.
 */
const MAILBOX_FANOUT_CONCURRENCY = 5;
const MAILBOX_FANOUT_TIMEOUT_MS = 8000;

/**
 * The external send request shape shared by the compose + approve send lanes
 * (engine-agnostic; callEngine dispatches Stalwart vs the external provider).
 */
interface SendReq {
  fromAddress: string;
  fromName: string | null;
  toAddress: string;
  /** The full recipient list (webmail wave: multi-recipient fan-out); toAddress is its first entry. */
  toAddresses?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  inReplyToThreadId: string | null;
  transactional: boolean;
  // webmail wave: compose extension (all optional, back-compat).
  cc?: string[];
  bcc?: string[];
  attachments?: { blobId: string; name: string; type: string }[];
  /** The resolved Message-ID header of the message being replied to. */
  inReplyTo?: string | null;
  references?: string[];
  /** Wave 7: custom outbound headers (the agent auto-reply loop marker). */
  headers?: { name: string; value: string }[];
}

/**
 * Wave 7: the header stamped on every runtime auto-reply send. The runtime
 * suppresses drafting a reply to any inbound that carries it (loop protection).
 */
export const AGENT_AUTOREPLY_HEADER = 'X-UC-Agent-Autoreply';

interface DraftReq {
  toAddress: string;
  toAddresses?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  cc?: string[];
  bcc?: string[];
  attachments?: { blobId: string; name: string; type: string }[];
  /** Internal id of the message being replied to — resolved to In-Reply-To /
   *  References headers so a saved reply-draft threads under the conversation. */
  inReplyToMessageId?: string | null;
}

/** The result callEngine() returns (normalized across Stalwart + provider). */
interface EngineSendResult {
  accepted: boolean;
  providerMessageId: string | null;
  threadId: string | null;
  lane: string | null;
  reason: string | null;
}

/**
 * What composeEmail's phase 1 (validate + record, in a short tx) hands to phase 2
 * (the external send, outside any tx). `done` short-circuits (idempotent hit or a
 * staged draft — nothing to send); `send` carries the QUEUED row + the plan.
 */
type ComposePrep =
  | { done: MessageComposeView; notify?: ApprovalPendingNotice }
  | {
      send: {
        messageId: string;
        mailbox: MailboxAccount | null;
        agentKey: string | null;
        subject: string | null;
        req: SendReq;
      };
    };

/**
 * What approveAgentInboxItem's phase 1 hands forward: `null` → 404; `result` → a
 * terminal answer (non-pending no-op, or a cleanup item executed in-tx); `send` →
 * the approved email draft to hand to the engine in phase 2.
 */
type ApprovePrep =
  | { kind: 'null' }
  | { kind: 'result'; value: { inbox: AgentInboxView; message: MessageComposeView | null } }
  | {
      kind: 'native-cleanup';
      itemId: string;
      disposition: MessageDisposition;
      threadIds: string[];
      draftedBy: string | null;
    }
  | {
      kind: 'send';
      itemId: string;
      messageId: string;
      draftedBy: string | null;
      subject: string | null;
      mailbox: MailboxAccount | null;
      req: SendReq;
    };

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  /**
   * Provenance sources trusted to send WITHOUT a registered agent: the human web
   * client and known first-party federation partners. Any other unregistered
   * source that requests 'send' is fail-safed to a staged draft (see autonomy.ts).
   * Override/extend via EMAIL_OPS_TRUSTED_COMPOSE_SOURCES (comma-separated).
   */
  private readonly trustedComposeSources = new Set(
    (process.env.EMAIL_OPS_TRUSTED_COMPOSE_SOURCES ?? 'email-ops-client,customer-ops')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
    private readonly connectedAccounts: ConnectedAccountsService,
    private readonly mailProvider: MailProviderPort,
    // Wave 9: the Stable approval-notification seam. Optional (last) so the
    // positional-construction unit specs stay valid; guarded on every use.
    // Dormant unless the notify webhook env is wired.
    private readonly notifier?: StableNotifierService,
  ) {}

  /**
   * Fire-and-forget an approval-pending ping to Stable (Wave 9). Called ONLY after
   * the staging tx has COMMITTED — a notify failure must never roll back mail
   * state, and a rolled-back stage must never have notified. The notifier itself
   * is degrade-clean/never-throws; this .catch is belt-and-braces.
   */
  private fireApprovalNotice(notice: ApprovalPendingNotice): void {
    if (!this.notifier) return;
    void this.notifier.notifyApprovalPending(notice).catch((err) =>
      this.logger.warn(`approval notify failed for item ${notice.id}: ${(err as Error).message}`),
    );
  }

  // ── status mapping ─────────────────────────────────────────────────────

  private statusWire(status: EmailMessageStatus): string {
    return status.toLowerCase();
  }

  private modeWire(mode: EmailMode): string {
    return mode.toLowerCase();
  }

  /**
   * May this caller act THROUGH this mailbox (read its live folders / send from
   * it)? A HUMAN mailbox is a person's PRIVATE account — only its owner (ucUid)
   * may. SHARED / AGENT mailboxes are workspace resources (already workspace-
   * fenced), so any member may. This is the per-USER fence the workspaceId
   * predicate alone does not give: without it a co-member could pass another
   * member's external (gmail/microsoft) mailboxId and the server would fetch
   * THAT owner's KC-broker token — reading or sending as them. (Mirrors the
   * send-as check in composeEmail; that one is stricter — explicit "send AS" also
   * forbids AGENT boxes — so the two predicates intentionally differ.)
   */
  private async mayActThroughMailbox(
    mailbox: { ownerKind: string; ownerKey: string | null },
    ucUid: string | null,
  ): Promise<boolean> {
    if ((mailbox.ownerKind as string) !== 'HUMAN') return true; // SHARED/AGENT = workspace resource
    if (!mailbox.ownerKey || !ucUid) return false;
    if (mailbox.ownerKey === ucUid) return true;
    // ownerKey is canonically the keycloakId, but ucUid can arrive as the local
    // User.id (auth-path dependent) — resolve the caller by EITHER identity and
    // accept a match on either, so a legitimate owner is never falsely fenced out.
    const u = await this.prisma.user.findFirst({
      where: { OR: [{ keycloakId: ucUid }, { id: ucUid }] },
    });
    return !!u && (mailbox.ownerKey === u.keycloakId || mailbox.ownerKey === u.id);
  }

  // ── 1. list_threads_with_contact ───────────────────────────────────────

  /**
   * The mailbox threads with a contact: the live Stalwart threads (when the
   * engine is configured) UNION the workspace's own outbound thread rows (the
   * SoR), deduped by thread id, newest-first. Viewer-level (no dual SKU).
   */
  async listThreadsWithContact(
    workspaceId: string,
    ucUid: string | null,
    contactId: string,
  ): Promise<ThreadView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // The deliverable address + default mailbox for the workspace (if any).
      const mailbox = await this.defaultMailbox(tx, workspaceId);
      const address = await this.contactAddress(tx, workspaceId, contactId);

      // Live Stalwart threads (degrade-clean: [] when unconfigured).
      let live: StalwartThread[] = [];
      if (mailbox && address) {
        live = await this.stalwart.listThreads(mailbox.emailAddress, address);
      }

      // The workspace's own outbound SoR rows for this contact, projected as
      // thin threads (so a brand-new outbound the cockpit just composed shows in
      // the 360 even before the engine surfaces it).
      const own = await tx.emailMessage.findMany({
        // Explicit tenant fence (correct now while RLS is inert under the owner
        // role, and after the role flip): never read another workspace's rows.
        where: { workspaceId, contactId, threadId: { not: null } },
        orderBy: { createdAt: 'desc' },
      });

      const byThread = new Map<string, ThreadView>();
      for (const t of live) {
        byThread.set(t.id, {
          id: t.id,
          subject: t.subject,
          message_count: t.messageCount,
          unread: t.unread,
          flagged: t.flagged,
          last_message_at: t.lastMessageAt,
          last_snippet: t.lastSnippet,
          participants: t.participants.map((p) => ({ address: p.address, name: p.name })),
        });
      }
      for (const m of own) {
        const tid = m.threadId as string;
        if (byThread.has(tid)) continue; // live thread wins (richer).
        byThread.set(tid, {
          id: tid,
          subject: m.subject ?? null,
          message_count: 1,
          unread: false,
          last_message_at: (m.sentAt ?? m.createdAt)?.toISOString() ?? null,
          last_snippet: m.preview ?? this.snippet(m.body),
          participants: [
            ...(m.fromAddress ? [{ address: m.fromAddress, name: null }] : []),
            ...(m.toAddress ? [{ address: m.toAddress, name: null }] : []),
          ],
        });
      }
      return [...byThread.values()];
    });
  }

  // ── 2. list_thread_messages ────────────────────────────────────────────

  /**
   * The messages in a thread: live Stalwart previews UNION the SoR outbound
   * rows, deduped by message id, oldest-first. Viewer-level.
   */
  async listThreadMessages(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
    mailboxId?: string,
  ): Promise<MessageView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // When a mailbox is named (the client BFF passes it) use it — so external
      // (gmail/microsoft) threads read through their provider; otherwise fall
      // back to the workspace default (the federation/MCP contract path).
      const mailbox = mailboxId
        ? await tx.mailboxAccount.findFirst({ where: { id: mailboxId, workspaceId } })
        : await this.defaultMailbox(tx, workspaceId);

      let live: MessageView[] = [];
      if (mailbox && this.mailProvider.handles(mailbox)) {
        // Per-user fence (see mayActThroughMailbox): never reveal a co-member's
        // external thread — the read runs on the mailbox OWNER's broker token.
        if (!(await this.mayActThroughMailbox(mailbox, ucUid))) return [];
        live = await this.mailProvider.listThreadMessages(mailbox, threadId);
      } else if (mailbox) {
        // webmail wave: the FULL detail (bodies/cc/threading headers/read
        // state/attachments) — a superset of the previous previews-only read.
        const details = await this.stalwart.getThreadDetail(mailbox.emailAddress, threadId);
        live = details.map((m) => this.toDetailedMessageView(m));
      }

      const own = await tx.emailMessage.findMany({
        where: { workspaceId, threadId },
        orderBy: { createdAt: 'asc' },
      });

      const byId = new Map<string, MessageView>();
      for (const m of live) byId.set(m.id, m);
      for (const m of own) {
        if (byId.has(m.id)) continue;
        byId.set(m.id, {
          id: m.id,
          thread_id: m.threadId ?? threadId,
          from: m.fromAddress ? { address: m.fromAddress, name: null } : null,
          to: m.toAddress ? [{ address: m.toAddress, name: null }] : [],
          subject: m.subject ?? null,
          sent_at: (m.sentAt ?? m.createdAt)?.toISOString() ?? null,
          preview: m.preview ?? this.snippet(m.body),
          direction: m.direction.toLowerCase(),
        });
      }
      const messages = [...byId.values()];
      if (mailbox) {
        await this.rememberContactsFromMessages(tx, workspaceId, mailbox.id, mailbox.emailAddress, messages);
      }
      return messages;
    });
  }

  /**
   * The mailbox's recent threads — the human email client's inbox list.
   * Search+paging (webmail wave): `query` is a JMAP full-text filter, `offset`
   * pages through the folder. Workspace-scoped.
   *
   * Sourcing (webmail wave): for a JMAP-backed (sovereign) mailbox, live
   * engine threads for the requested folder are now fetched directly — JMAP's
   * own Mailbox role IS authoritative folder membership for real mail. The
   * local ThreadDisposition overlay continues to govern ONLY the thin
   * locally-composed SoR rows that have no live JMAP counterpart yet (the
   * SAME "live wins" dedup pattern listThreadsWithContact already uses), so a
   * pre-existing disposition-only thread keeps working exactly as before while
   * live mail now correctly appears. That local supplement is only merged in
   * on the plain, first-page call (no `query`, offset===0) — a search or a
   * page beyond the first is answered purely from the live, paged JMAP result
   * (mixing in an un-paged, unfiltered local supplement there would be wrong).
   */
  async listMailboxInbox(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    limit = 50,
    folder: MailFolder = 'inbox',
    query?: string | null,
    offset = 0,
  ): Promise<ThreadView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await tx.mailboxAccount.findFirst({ where: { id: mailboxId, workspaceId } });
      if (!mailbox) return [];

      // External account (gmail / microsoft): the provider folders are
      // authoritative — fetch the live folder threads through the provider (the
      // KC-broker token + the cleaner-engine). Degrade-clean: [] when the account
      // isn't connected or the engine is dormant. The local disposition overlay
      // stays a sovereign-mailbox concern (sync-back to the provider is a follow-up).
      // NOTE (webmail wave): the external-provider port doesn't yet carry a
      // `query`/`offset` param — a search/page-2+ request against an external
      // mailbox still returns its first `limit` unfiltered results (documented
      // limitation; see the wave report).
      if (this.mailProvider.handles(mailbox)) {
        // Per-user fence: a HUMAN external mailbox is private to its owner — never
        // surface a co-member's connected inbox just because it shares the workspace.
        if (!(await this.mayActThroughMailbox(mailbox, ucUid))) return [];
        return this.mailProvider.listInbox(mailbox, { folder, limit });
      }

      const addr = mailbox.emailAddress;

      // webmail wave: the live, folder-scoped (+ searched + paged) JMAP threads.
      const live = await this.liveFolderThreads(addr, folder, limit, offset, query);

      // A search or any page beyond the first is answered purely from the live
      // result — correct paging/filtering needs the engine's own position+text
      // semantics, which the local-only supplement below doesn't have. Still
      // overlay-filter it so a triaged-out thread never shows in the wrong folder.
      if ((query && query.trim()) || offset > 0) {
        return this.overlayFilterThreads(tx, workspaceId, live, folder);
      }

      // The message scope per folder. Disposition folders look at every thread
      // the mailbox participates in (received + sent) and are then narrowed by
      // the overlay; sent/drafts derive purely from the SoR direction/status.
      const scope: Prisma.EmailMessageWhereInput =
        folder === 'sent'
          ? { fromAddress: addr, direction: EmailDirection.SENT }
          : folder === 'drafts'
            ? { fromAddress: addr, status: EmailMessageStatus.DRAFT }
            : { OR: [{ fromAddress: addr }, { toAddress: addr }] };

      const msgs = await tx.emailMessage.findMany({
        where: { workspaceId, threadId: { not: null }, ...scope },
        orderBy: { createdAt: 'desc' },
        take: 300,
      });

      const byThread = new Map<
        string,
        {
          id: string;
          subject: string | null;
          count: number;
          last: Date;
          snippet: string | null;
          participants: Set<string>;
        }
      >();
      for (const m of msgs) {
        const tid = m.threadId as string;
        const when = m.sentAt ?? m.createdAt ?? new Date(0);
        const cur = byThread.get(tid);
        if (!cur) {
          byThread.set(tid, {
            id: tid,
            subject: m.subject ?? null,
            count: 1,
            last: when,
            snippet: m.preview ?? this.snippet(m.body),
            participants: new Set([m.toAddress].filter((a): a is string => !!a)),
          });
        } else {
          cur.count += 1;
          if (m.toAddress) cur.participants.add(m.toAddress);
          if (when.getTime() > cur.last.getTime()) {
            cur.last = when;
            cur.snippet = m.preview ?? this.snippet(m.body);
            cur.subject = cur.subject ?? m.subject ?? null;
          }
        }
      }

      const sorted = [...byThread.values()].sort((a, b) => b.last.getTime() - a.last.getTime());

      // Merge the disposition overlay (default INBOX for any thread with no row),
      // then narrow to the requested folder. NOTE: the take:300 scan above bounds
      // how far back triaged threads surface — fine for the thin SoR today; the
      // engine-backed inbound path will index received mail directly.
      const dispoRows = await tx.threadDisposition.findMany({
        where: { workspaceId, threadId: { in: sorted.map((t) => t.id) } },
      });
      const dispoBy = new Map(dispoRows.map((d) => [d.threadId, d.disposition]));
      const effective = (id: string): MessageDisposition =>
        dispoBy.get(id) ?? MessageDisposition.INBOX;

      const visible = sorted.filter((t) => {
        const d = effective(t.id);
        switch (folder) {
          case 'archive':
            return d === MessageDisposition.ARCHIVE;
          case 'spam':
            return d === MessageDisposition.SPAM;
          case 'trash':
            return d === MessageDisposition.TRASH;
          case 'inbox':
            // Inbox hides anything triaged out (archive / trash / spam).
            return d === MessageDisposition.INBOX;
          default:
            return true; // sent / drafts: not disposition-filtered.
        }
      });

      const localThreads: ThreadView[] = visible.slice(0, limit).map((t) => ({
        id: t.id,
        subject: t.subject,
        message_count: t.count,
        unread: false,
        last_message_at: t.last.toISOString(),
        last_snippet: t.snippet,
        participants: [...t.participants].map((address) => ({ address, name: null })),
        disposition: effective(t.id),
      }));

      // Live JMAP threads win on id collision (richer/authoritative); local-only
      // rows fill in anything the engine hasn't (yet) surfaced.
      const byId = new Map<string, ThreadView>();
      for (const t of live) byId.set(t.id, t);
      for (const t of localThreads) if (!byId.has(t.id)) byId.set(t.id, t);
      const merged = [...byId.values()].sort((a, b) => this.threadTime(b) - this.threadTime(a));
      // Overlay-filter the LIVE half too: a thread just archived/trashed must not
      // reappear in the inbox from the live JMAP result before James finishes the
      // move (the "triage undoes itself" bug). The overlay is view-authoritative.
      const filtered = await this.overlayFilterThreads(tx, workspaceId, merged, folder);
      return filtered.slice(0, limit);
    });
  }

  /** ISO `last_message_at` -> epoch ms (0 for null/unparseable), for merge-sorting ThreadViews. */
  private threadTime(t: ThreadView): number {
    return t.last_message_at ? Date.parse(t.last_message_at) || 0 : 0;
  }

  /**
   * Live, folder-scoped (+ searched + paged) JMAP threads for one mailbox,
   * mapped onto the ThreadView wire shape. Degrade-clean: [] when the engine
   * isn't configured / the call fails (StalwartPort.listFolderThreads never
   * throws).
   */
  private async liveFolderThreads(
    address: string,
    folder: MailFolder,
    limit: number,
    offset: number,
    query?: string | null,
    mailboxId?: string | null,
  ): Promise<ThreadView[]> {
    if (!this.stalwart.isConfigured()) return [];
    const { threads } = await this.stalwart.listFolderThreads(address, {
      folder,
      limit,
      offset,
      query: query ?? null,
      // A custom-folder id scopes the query straight to that mailbox (folder ignored).
      mailboxId: mailboxId ?? null,
    });
    return threads.map((t) => ({
      id: t.id,
      subject: t.subject,
      message_count: t.messageCount,
      unread: t.unread,
      flagged: t.flagged,
      last_message_at: t.lastMessageAt,
      last_snippet: t.lastSnippet,
      participants: t.participants.map((p) => ({ address: p.address, name: p.name })),
      has_attachments: t.hasAttachments,
    }));
  }

  // ── webmail wave: unified inbox / counts / read state / blobs / bulk ────

  /**
   * The workspace mailboxes this caller may READ through (workspace-fenced +
   * the per-user HUMAN-mailbox fence). Shared helper for the aggregate/counts
   * fan-outs. Runs inside the caller's tx.
   */
  private async readableMailboxes(
    tx: WorkspaceTxClient,
    workspaceId: string,
    ucUid: string | null,
  ): Promise<MailboxAccount[]> {
    const all = await tx.mailboxAccount.findMany({
      where: { workspaceId, active: true },
      orderBy: { createdAt: 'asc' },
    });
    const out: MailboxAccount[] = [];
    for (const mb of all) {
      if (await this.mayActThroughMailbox(mb, ucUid)) out.push(mb);
    }
    return out;
  }

  /**
   * UNIFIED INBOX (webmail wave): fan out across ALL workspace mailboxes the
   * caller may read, CONCURRENTLY (Promise.allSettled — one failing account
   * never fails the whole response, it is simply omitted), merge-sort by
   * last-activity desc, and apply `limit` AFTER the merge. Every item carries
   * `mailbox_id` + `mailbox_address`. `offset` pages each account (plain row
   * offset per account, exactly like the single-mailbox list) — a full page
   * (length == limit) still means "may have more".
   */
  async listAggregateInbox(
    workspaceId: string,
    ucUid: string | null,
    folder: MailFolder = 'inbox',
    limit = 50,
    query?: string | null,
    offset = 0,
  ): Promise<ThreadView[]> {
    const mailboxes = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      this.readableMailboxes(tx, workspaceId, ucUid),
    );
    // Bounded + timed fan-out: at most MAILBOX_FANOUT_CONCURRENCY reads in flight,
    // each capped at MAILBOX_FANOUT_TIMEOUT_MS so one slow provider can't stall
    // the whole aggregate. A failed/timed-out mailbox is a rejected slot we omit
    // (partial results) — never a 500 (the degrade-clean contract the FE relies on).
    const settled = await mapWithConcurrency(mailboxes, MAILBOX_FANOUT_CONCURRENCY, (mb) =>
      withTimeout(
        this.listMailboxInbox(workspaceId, ucUid, mb.id, limit, folder, query, offset).then(
          (threads) =>
            threads.map((t) => ({ ...t, mailbox_id: mb.id, mailbox_address: mb.emailAddress })),
        ),
        MAILBOX_FANOUT_TIMEOUT_MS,
        `aggregate inbox read for ${mb.emailAddress}`,
      ),
    );
    const merged: ThreadView[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        merged.push(...r.value);
      } else {
        this.logger.warn(
          `aggregate inbox: mailbox ${mailboxes[i]?.emailAddress ?? '?'} failed (${(r.reason as Error)?.message ?? r.reason}) — omitted from the merged view`,
        );
      }
    });
    // Dedupe defensively (same thread id seen under one mailbox only), then merge-
    // sort DETERMINISTICALLY: newest first, with stable tiebreaks (mailbox, then
    // thread id) so equal timestamps across mailboxes always order the same way.
    const seen = new Set<string>();
    const deduped = merged.filter((t) => {
      const key = `${t.mailbox_id ?? ''}:${t.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => {
      const dt = this.threadTime(b) - this.threadTime(a);
      if (dt !== 0) return dt;
      const ma = (a.mailbox_address ?? '').localeCompare(b.mailbox_address ?? '');
      if (ma !== 0) return ma;
      return a.id.localeCompare(b.id);
    });
    return deduped.slice(0, limit);
  }

  /**
   * COUNTS (webmail wave): the Inbox unread/total per workspace mailbox, via
   * the engine's Mailbox surface (JMAP role:inbox), fetched CONCURRENTLY. A
   * failing / unsupported account becomes a zeroed entry with `error: true`
   * rather than being dropped (the client renders the mailbox row either way).
   */
  async getWorkspaceMailCounts(
    workspaceId: string,
    ucUid: string | null,
  ): Promise<MailboxCountsView[]> {
    const mailboxes = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      this.readableMailboxes(tx, workspaceId, ucUid),
    );
    // Same bounded + timed fan-out as the aggregate: a slow account times out
    // into a rejected slot (→ error:true below) instead of stalling the row.
    const settled = await mapWithConcurrency(mailboxes, MAILBOX_FANOUT_CONCURRENCY, (mb) => {
      // External-provider mailboxes have no engine counts surface (yet) —
      // honest zeros + error:true, same as a failing sovereign account.
      if (this.mailProvider.handles(mb)) return Promise.resolve(null);
      return withTimeout(
        this.stalwart.getMailboxCounts(mb.emailAddress),
        MAILBOX_FANOUT_TIMEOUT_MS,
        `mail counts for ${mb.emailAddress}`,
      );
    });
    return mailboxes.map((mb, i) => {
      const r = settled[i];
      const counts = r.status === 'fulfilled' ? r.value : null;
      if (r.status === 'rejected') {
        this.logger.warn(
          `mail counts: mailbox ${mb.emailAddress} failed (${(r.reason as Error)?.message ?? r.reason}) — zeroed entry`,
        );
      }
      return counts
        ? {
            mailbox_id: mb.id,
            address: mb.emailAddress,
            inbox_unread: counts.inboxUnread,
            inbox_total: counts.inboxTotal,
          }
        : {
            mailbox_id: mb.id,
            address: mb.emailAddress,
            inbox_unread: 0,
            inbox_total: 0,
            error: true,
          };
    });
  }

  /**
   * READ STATE (webmail wave): set/clear `$seen` on every message in a thread
   * via the engine (JMAP Email/set) — or, for an EXTERNAL (Gmail/M365) mailbox,
   * flip the REAL provider read state through the MailProviderPort (triage
   * parity: the actual Gmail box changes, not just this app's view).
   * `updated:false` means the engine/provider could not apply it (unknown
   * thread / not connected / dormant engine) — degrade-clean, not an error.
   * The mailbox is workspace-fenced + per-user fenced like every other
   * mailbox-scoped read/write.
   */
  async setThreadReadState(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    threadId: string,
    read: boolean,
  ): Promise<{ thread_id: string; read: boolean; updated: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox) {
      return { thread_id: threadId, read, updated: false };
    }
    if (this.mailProvider.handles(mailbox)) {
      const updated = await this.mailProvider.setThreadRead(mailbox, threadId, read);
      return { thread_id: threadId, read, updated };
    }
    const updated = await this.stalwart.setThreadRead(mailbox.emailAddress, threadId, read);
    return { thread_id: threadId, read, updated };
  }

  async setThreadFlagState(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    threadId: string,
    flags: { flagged?: boolean; seen?: boolean },
  ): Promise<{ thread_id: string; flagged?: boolean; seen?: boolean; updated: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) {
      return { thread_id: threadId, ...flags, updated: false };
    }
    const updated = await this.stalwart.setThreadFlags(mailbox.emailAddress, threadId, flags);
    return { thread_id: threadId, ...flags, updated };
  }

  /**
   * ATTACHMENT DOWNLOAD (webmail wave): fetch one blob's bytes from the
   * engine's blob store, scoped to the mailbox's account. Null when the
   * mailbox is out of reach, the engine can't serve blobs, or the blob is
   * unknown — the controller maps null to 404 (never a 500).
   */
  async downloadAttachment(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    blobId: string,
  ): Promise<{ data: Buffer; contentType: string | null } | null> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return null;
    return this.stalwart.downloadBlob(mailbox.emailAddress, blobId);
  }

  /**
   * ATTACHMENT UPLOAD (webmail wave): push a file into the engine's blob store
   * under the mailbox's account; the returned blob_id is later referenced by a
   * compose. Null when the mailbox is out of reach or the engine can't accept
   * uploads — the controller maps null to 501 (never a 500).
   */
  async uploadAttachment(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    file: Buffer,
    type: string,
    filename: string,
  ): Promise<{ blob_id: string; name: string; type: string; size: number } | null> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return null;
    const up = await this.stalwart.uploadBlob(mailbox.emailAddress, file, type, filename);
    if (!up) return null;
    return { blob_id: up.blobId, name: filename, type: up.type, size: up.size };
  }

  /**
   * The read/unread half of BULK (webmail wave): the bulk route is
   * workspace-level (no mailbox in the path) while thread ids live per-account
   * — so try each readable mailbox in turn until one accepts the toggle.
   * Sovereign boxes go through the JMAP engine; EXTERNAL (Gmail/M365) boxes go
   * through the MailProviderPort so the REAL provider read state flips too
   * (a foreign thread id simply comes back false and the loop moves on).
   * Bounded: bulk lists are small and the loop stops at the first success per
   * thread. False = no account knew the thread.
   */
  async setThreadReadAcrossMailboxes(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
    read: boolean,
  ): Promise<boolean> {
    const mailboxes = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      this.readableMailboxes(tx, workspaceId, ucUid),
    );
    for (const mb of mailboxes) {
      if (this.mailProvider.handles(mb)) {
        if (await this.mailProvider.setThreadRead(mb, threadId, read)) return true;
        continue;
      }
      if (await this.stalwart.setThreadRead(mb.emailAddress, threadId, read)) return true;
    }
    return false;
  }

  /** The James folder a disposition maps to (SPAM lives in the junk folder). */
  private dispositionFolder(disposition: MessageDisposition): MailFolder {
    switch (disposition) {
      case MessageDisposition.ARCHIVE:
        return 'archive';
      case MessageDisposition.TRASH:
        return 'trash';
      case MessageDisposition.SPAM:
        return 'spam';
      default:
        return 'inbox';
    }
  }

  /**
   * Reconcile a thread's folder placement into the ACTUAL mailbox (the overlay's
   * move half). Like the read toggle, the caller path is workspace-level while
   * thread ids are per-account — so try each readable mailbox until one owns the
   * thread. Sovereign boxes move via James (JMAP Email/set); EXTERNAL (Gmail/M365)
   * boxes reconcile ARCHIVE/TRASH/SPAM/INBOX-restore through the MailProviderPort
   * so the triage is REAL in the provider mailbox too. Returns true when a real
   * move happened; false when no account knew the thread. Best-effort: never
   * throws, so a degraded engine/provider can't block the overlay write that
   * follows.
   */
  async moveThreadToFolderAcrossMailboxes(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
    disposition: MessageDisposition,
  ): Promise<boolean> {
    const folder = this.dispositionFolder(disposition);
    const mailboxes = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      this.readableMailboxes(tx, workspaceId, ucUid),
    );
    for (const mb of mailboxes) {
      if (this.mailProvider.handles(mb)) {
        try {
          if (
            disposition === MessageDisposition.ARCHIVE &&
            (await this.mailProvider.archiveThread(mb, threadId))
          ) {
            return true;
          }
          if (
            disposition === MessageDisposition.TRASH &&
            (await this.mailProvider.trashThread(mb, threadId))
          ) {
            return true;
          }
          if (
            disposition === MessageDisposition.SPAM &&
            (await this.mailProvider.spamThread(mb, threadId))
          ) {
            return true;
          }
          if (
            disposition === MessageDisposition.INBOX &&
            (await this.mailProvider.restoreThreadToInbox(mb, threadId))
          ) {
            return true;
          }
        } catch {
          // degrade-clean: try the next mailbox
        }
        continue;
      }
      try {
        if (await this.stalwart.moveThreadToFolder(mb.emailAddress, threadId, folder)) return true;
      } catch {
        // degrade-clean: try the next mailbox
      }
    }
    return false;
  }

  /**
   * Apply a MANUAL thread disposition (reader / bulk-bar Archive・Trash・Spam・
   * Inbox) so the triage is REAL, not just an overlay tag: reconcile the actual
   * mailbox — James (Email/set move) for sovereign boxes, the provider port
   * (Gmail/M365 archive/trash/spam/inbox-restore) for external ones — AND write
   * the overlay in one step. Without the move, the thread stays in the real inbox and reappears on
   * the next live refetch (the "triage undoes itself" bug). Best-effort move
   * (never throws); the overlay is ALWAYS written so the view is correct even if
   * the engine/provider is briefly unreachable.
   */
  async applyThreadDisposition(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
    disposition: MessageDisposition,
    opts?: { agentKey?: string | null },
  ): Promise<DispositionView & { moved: boolean }> {
    const moved = await this.moveThreadToFolderAcrossMailboxes(
      workspaceId,
      ucUid,
      threadId,
      disposition,
    );
    const row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.threadDisposition.upsert({
        where: { workspaceId_threadId: { workspaceId, threadId } },
        create: {
          workspaceId,
          threadId,
          disposition,
          setByUcUid: ucUid,
          setByAgentKey: opts?.agentKey ?? null,
        },
        update: { disposition, setByUcUid: ucUid, setByAgentKey: opts?.agentKey ?? null },
      }),
    );
    return {
      thread_id: row.threadId,
      disposition: row.disposition,
      set_by_uc_uid: row.setByUcUid,
      set_by_agent_key: row.setByAgentKey,
      updated_at: row.updatedAt.toISOString(),
      moved,
    };
  }

  /**
   * Drop threads that have been triaged OUT of the requested folder per the
   * overlay — applied to the live JMAP result too, so a thread the user just
   * archived does not flash back into the inbox while James finishes the move.
   * The overlay is authoritative for the VIEW. Sent/Drafts are direction-derived,
   * never disposition-filtered.
   */
  private async overlayFilterThreads(
    tx: WorkspaceTxClient,
    workspaceId: string,
    threads: ThreadView[],
    folder: MailFolder,
  ): Promise<ThreadView[]> {
    if (folder === 'sent' || folder === 'drafts' || threads.length === 0) return threads;
    const rows = await tx.threadDisposition.findMany({
      where: { workspaceId, threadId: { in: threads.map((t) => t.id) } },
    });
    const by = new Map(rows.map((r) => [r.threadId, r.disposition]));
    const want =
      folder === 'archive'
        ? MessageDisposition.ARCHIVE
        : folder === 'spam'
          ? MessageDisposition.SPAM
          : folder === 'trash'
            ? MessageDisposition.TRASH
            : MessageDisposition.INBOX;
    return threads.filter((t) => (by.get(t.id) ?? MessageDisposition.INBOX) === want);
  }

  /**
   * Parse the JSON attachments persisted on a staged draft back into the send
   * lane's `{ blobId, name, type }[]` shape — so an approved draft re-sends the
   * exact attachments the approver reviewed. Tolerant: garbage → undefined.
   */
  private parseStoredAttachments(
    raw: Prisma.JsonValue | null | undefined,
  ): { blobId: string; name: string; type: string }[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: { blobId: string; name: string; type: string }[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const a = item as Record<string, unknown>;
      // The stage path persists the ComposeInput shape verbatim (`blob_id`,
      // wire-style); older rows carried camelCase. Accept EITHER so no staged
      // draft ever re-sends without the attachments the approver reviewed.
      const blobId = String(a.blobId ?? a.blob_id ?? '');
      if (!blobId) continue;
      out.push({
        blobId,
        name: String(a.name ?? ''),
        type: String(a.type ?? 'application/octet-stream'),
      });
    }
    return out.length ? out : undefined;
  }

  async emptyMailboxFolder(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    folder: 'trash' | 'spam',
  ): Promise<{ folder: 'trash' | 'spam'; purged: number; updated: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) {
      return { folder, purged: 0, updated: false };
    }
    const purged = await this.stalwart.emptyFolder(mailbox.emailAddress, folder);
    return { folder, purged: purged ?? 0, updated: purged != null };
  }

  // --- custom folders / labels (James JMAP Mailbox CRUD) ------------------
  // All folder ops are James-only + workspace-scoped: resolve the mailbox for
  // the caller, refuse an external-provider (Gmail/M365) mailbox, then delegate
  // to the engine. Degrade-clean throughout (unresolved/dormant → []/null/false).

  /** Every folder (system role + custom) under one workspace mailbox. */
  async listMailboxFolders(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<StalwartMailFolder[]> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return [];
    return this.stalwart.listFolders(mailbox.emailAddress);
  }

  /** Create a custom folder under one workspace mailbox. */
  async createMailboxFolder(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    name: string,
    parentId: string | null,
  ): Promise<{ id: string } | null> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return null;
    return this.stalwart.createFolder(mailbox.emailAddress, name, parentId);
  }

  /** Rename a custom folder. `updated:false` when the engine could not apply it. */
  async renameMailboxFolder(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    folderId: string,
    name: string,
  ): Promise<{ updated: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return { updated: false };
    return { updated: await this.stalwart.renameFolder(mailbox.emailAddress, folderId, name) };
  }

  /**
   * Delete a custom folder. `deleted:false` when the engine refused it — a
   * system/role folder is inviolable (the engine layer enforces that), or the
   * folder is unknown / the mailbox is external / the engine is dormant.
   */
  async deleteMailboxFolder(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    folderId: string,
  ): Promise<{ deleted: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return { deleted: false };
    return { deleted: await this.stalwart.deleteFolder(mailbox.emailAddress, folderId) };
  }

  /**
   * The live threads INSIDE a custom folder (by JMAP mailbox id). Custom folders
   * carry no disposition overlay + no local SoR rows, so this is a pure live-JMAP
   * read (no merge, no overlay-filter) — [] when dormant/external/unknown.
   */
  async listCustomFolderThreads(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    folderId: string,
    limit: number,
    query: string | null,
    offset: number,
  ): Promise<ThreadView[]> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return [];
    return this.liveFolderThreads(mailbox.emailAddress, 'inbox', limit, offset, query, folderId);
  }

  /**
   * Move a thread INTO a custom folder (arbitrary JMAP mailbox id). The engine
   * validates the target belongs to the account. `moved:false` when refused /
   * unknown / external / dormant.
   */
  async moveThreadToCustomFolder(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    threadId: string,
    targetFolderId: string,
  ): Promise<{ moved: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) return { moved: false };
    return { moved: await this.stalwart.moveThreadToMailbox(mailbox.emailAddress, threadId, targetFolderId) };
  }

  async saveOrUpdateDraft(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    draftId: string | null,
    payload: DraftReq,
  ): Promise<{ draft_id: string | null; updated: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) {
      return { draft_id: draftId, updated: false };
    }
    // A reply draft carries the internal id of the message it answers; resolve it to
    // real In-Reply-To / References headers (the same path the send lane uses) so James
    // threads the draft under the conversation. Degrade-clean: unresolved → no headers,
    // the draft still saves (just un-threaded), never throws.
    let inReplyTo: string | null = null;
    let references: string[] | undefined;
    if (payload.inReplyToMessageId) {
      const resolved = await this.resolveReplyHeaders(
        mailbox,
        payload.inReplyToMessageId,
        workspaceId,
        ucUid,
      );
      if (resolved?.messageIdHeader) {
        inReplyTo = resolved.messageIdHeader;
        references = resolved.references ?? undefined;
      }
    }
    const draft: StalwartDraftRequest = {
      fromAddress: mailbox.emailAddress,
      fromName: mailbox.displayName ?? null,
      toAddress: payload.toAddress,
      toAddresses: payload.toAddresses?.length ? payload.toAddresses : undefined,
      subject: payload.subject,
      body: payload.body,
      bodyHtml: payload.bodyHtml ?? null,
      cc: payload.cc?.length ? payload.cc : undefined,
      bcc: payload.bcc?.length ? payload.bcc : undefined,
      attachments: payload.attachments?.length
        ? payload.attachments.map((a) => ({ blobId: a.blobId, name: a.name, type: a.type }))
        : undefined,
      inReplyTo,
      references,
    };
    const result = draftId
      ? await this.stalwart.updateDraft(mailbox.emailAddress, draftId, draft)
      : await this.stalwart.saveDraft(mailbox.emailAddress, draft);
    return { draft_id: result?.id ?? draftId, updated: !!result?.id };
  }

  async deleteDraft(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    draftId: string,
  ): Promise<{ draft_id: string; updated: boolean }> {
    const mailbox = await this.resolveMailboxForCaller(workspaceId, ucUid, mailboxId);
    if (!mailbox || this.mailProvider.handles(mailbox)) {
      return { draft_id: draftId, updated: false };
    }
    const updated = await this.stalwart.deleteDraft(mailbox.emailAddress, draftId);
    return { draft_id: draftId, updated };
  }

  /** Resolve a mailbox by id inside the workspace + apply the per-user HUMAN fence. */
  private async resolveMailboxForCaller(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<MailboxAccount | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await tx.mailboxAccount.findFirst({ where: { id: mailboxId, workspaceId } });
      if (!mailbox) return null;
      if (!(await this.mayActThroughMailbox(mailbox, ucUid))) return null;
      return mailbox;
    });
  }

  // ── 3. compose_email (idempotent; send vs draft) ───────────────────────

  /**
   * Compose an outbound email. IDEMPOTENT on (workspaceId, externalSource,
   * externalRef): a repeat returns the EXISTING message and queues NO second
   * send. mode=send hands to the mail engine; mode=draft stages the agent-inbox.
   */
  async composeEmail(
    workspaceId: string,
    ucUid: string | null,
    input: ComposeInput,
  ): Promise<MessageComposeView> {
    // PHASE 1 — validate, authorize, decide, and record the SoR row (a SHORT tx).
    // The external send is deferred to phase 2 so a slow provider (Gmail/Graph,
    // >5s) can't hold the Prisma interactive transaction open past its timeout and
    // roll back the SoR row for mail that already DELIVERED (the §3 send bug).
    const prep = await this.prisma.withWorkspace(
      workspaceId,
      ucUid,
      async (tx): Promise<ComposePrep> => {
        // Idempotency: a prior row with the same tuple returns unchanged.
        const existing = await tx.emailMessage.findUnique({
          where: {
            workspaceId_externalSource_externalRef: {
              workspaceId,
              externalSource: input.externalSource,
              externalRef: input.externalRef,
            },
          },
        });
        if (existing) {
          this.logger.log(
            `compose_email idempotent hit for (${workspaceId}, ${input.externalSource}, ${input.externalRef}) — returning existing message ${existing.id} (no second send)`,
          );
          return { done: this.composeView(existing) };
        }

        // Kill switch: when the workspace is paused, agents cannot compose/send.
        // (An idempotent repeat above still returns; a human approving an already-
        // staged draft is a separate path and stays unaffected.)
        const ws = await tx.workspace.findUnique({
          where: { id: workspaceId },
          select: { agentsPaused: true },
        });
        if (ws?.agentsPaused) {
          this.logger.log(`compose_email blocked: agents paused for workspace ${workspaceId}`);
          throw new ForbiddenException('Agents are paused for this workspace.');
        }

        // Resolve the registered agent that drafted this (by its provenance key).
        const agentKey = input.draftedBy ?? input.externalSource;
        const agent = agentKey
          ? await tx.agent.findFirst({
              where: { workspaceId, key: agentKey, active: true },
              select: {
                key: true,
                autonomyLevel: true,
                recipientPolicy: true,
                mailboxAccountId: true,
                paused: true,
              },
            })
          : null;

        // Per-agent kill switch: this ONE agent is paused (distinct from the
        // workspace-wide pause above, which freezes the whole fleet).
        if (agent?.paused) {
          this.logger.log(`compose_email blocked: agent '${agentKey}' is paused (workspace ${workspaceId})`);
          throw new ForbiddenException(`Agent '${agentKey}' is paused.`);
        }

        // Send identity: a registered agent sends from its OWN primary mailbox
        // (cached on Agent.mailboxAccountId = the isPrimary binding); an unregistered
        // agent falls back to the workspace default (legacy, unchanged). Fixes the
        // latent bug where an agent with a mailbox still sent from the ws default.
        // An explicit from-mailbox (the human client picks which inbox to send as)
        // wins when it's in-workspace; otherwise resolve the agent/default identity.
        const explicitFrom = input.fromMailboxAccountId
          ? await tx.mailboxAccount.findFirst({
              where: { id: input.fromMailboxAccountId, workspaceId },
            })
          : null;
        // Send-as authorization: a human client may send AS a SHARED mailbox or one
        // they personally own — never spoof another person's (or an agent's) identity.
        // (The agent path doesn't set fromMailboxAccountId; it uses resolveSendMailbox.)
        if (explicitFrom) {
          const kind = explicitFrom.ownerKind as string;
          // SHARED = a workspace resource (any member may send as it); HUMAN = a
          // person's own box (only the owner). Route the HUMAN owner-check through
          // mayActThroughMailbox so it resolves the caller by keycloakId OR User.id
          // and survives the same id-flavor ambiguity as the read path. AGENT (and
          // anything else) falls through -> denied (no impersonating an agent).
          const ownsIt =
            kind === 'SHARED' || (kind === 'HUMAN' && (await this.mayActThroughMailbox(explicitFrom, ucUid)));
          if (!ownsIt) {
            throw new ForbiddenException('You are not allowed to send as that mailbox.');
          }
        }
        const mailbox = explicitFrom ?? (await this.resolveSendMailbox(tx, workspaceId, agent));
        const fromAddress = mailbox?.emailAddress ?? null;

        // Enforce the autonomy dial — gate send-vs-draft by the agent's level +
        // recipient policy. Conservative: the decision only ever makes a send MORE
        // gated. For an UNREGISTERED provenance, a 'send' is honored only from a
        // TRUSTED first-party source (the human web client + known federation
        // partners); an unknown/attacker-controlled source is fail-safed to a
        // staged draft so prompt-injection can't drive an autonomous send.
        //
        // Wave 7: a REGISTERED agent requesting 'send' runs the full autonomy
        // MATRIX ("first contact needs a human; ongoing conversation flows") over
        // a context built here — sending-mailbox class, internal domains, trusted
        // correspondents, and the in-thread-reply-to-inbound proof. Every other
        // path (human/trusted sources, requested drafts, unregistered provenance)
        // takes the base gate with ZERO context queries — byte-identical to the
        // pre-wave behavior.
        const trustedUnregisteredSend =
          !agent && (agentKey == null || this.trustedComposeSources.has(agentKey));
        const requestedMode: 'send' | 'draft' = input.mode === 'draft' ? 'draft' : 'send';
        const agentContext =
          agent && requestedMode === 'send'
            ? await this.buildAgentComposeContext(tx, workspaceId, agent, mailbox, input)
            : null;
        const decision = decideAgentComposeMode({
          requestedMode,
          agent,
          toAddress: input.toAddress,
          trustedUnregisteredSend,
          agentContext,
        });
        // Upstream policy holds (e.g. the runtime's thread-rate-cap) merge with
        // the gate's own reasons on the staged item's policy payload.
        const agentInitiated = !!agent || input.externalSource === AGENT_REPLY_RUNTIME_SOURCE;
        const policyReasons: PolicyReason[] = [
          ...(agentInitiated ? input.policyReasons ?? [] : []),
          ...decision.reasons,
        ];
        const mode = decision.mode === 'draft' ? EmailMode.DRAFT : EmailMode.SEND;
        if (decision.coerced) {
          this.logger.log(
            `compose_email autonomy gate: agent '${agentKey}' send→draft (${decision.reason}) — staged for approval (workspace ${workspaceId})`,
          );
        } else if (mode === EmailMode.SEND && agent) {
          this.logger.log(
            `compose_email autonomy: agent '${agentKey}' autonomous send (${decision.reason}, audited) (workspace ${workspaceId})`,
          );
        }

        if (mode === EmailMode.DRAFT) {
          // Stage the draft into the agent-inbox approval surface (no external
          // call, so this whole path stays inside the one short tx).
          const msg = await tx.emailMessage.create({
            data: {
              workspaceId,
              mailboxAccountId: mailbox?.id ?? null,
              contactId: input.contactId,
              threadId: input.inReplyToThreadId ?? null,
              inReplyToThreadId: input.inReplyToThreadId ?? null,
              externalSource: input.externalSource,
              externalRef: input.externalRef,
              mode: EmailMode.DRAFT,
              status: EmailMessageStatus.PENDING_APPROVAL,
              direction: EmailDirection.DRAFT,
              fromAddress,
              toAddress: input.toAddress,
              subject: input.subject,
              body: input.body,
              preview: this.snippet(input.body),
              // Persist the FULL payload so approval sends exactly what was reviewed.
              toAddresses: input.toAddresses?.length ? input.toAddresses : [],
              ccAddresses: input.cc ?? [],
              bccAddresses: input.bcc ?? [],
              bodyHtml: input.bodyHtml ?? null,
              attachments: input.attachments?.length
                ? (input.attachments as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
              actorUcUid: ucUid,
            },
          });
          // Wave 7: persist WHY the send was held (machine+human reasons) on the
          // staged item — payload.policy is the source of truth the approval UI
          // renders; the summary carries a cheap one-code suffix. Created fresh
          // here, so there are no other payload keys to preserve.
          const held = agentInitiated && policyReasons.length > 0;
          const itemSummary =
            this.summary(input.subject, input.toAddress) +
            (held ? ` — held: ${policyReasons[0].code}` : '');
          const inboxItem = await tx.agentInboxItem.create({
            data: {
              workspaceId,
              messageId: msg.id,
              state: AgentInboxState.PENDING,
              draftedBy: input.draftedBy ?? input.externalSource,
              summary: itemSummary,
              ...(held
                ? {
                    payload: {
                      policy: { decision: 'hold', reasons: policyReasons },
                    } as unknown as Prisma.InputJsonValue,
                  }
                : {}),
            },
          });
          if (mailbox) {
            await this.rememberContacts(tx, workspaceId, mailbox.id, mailbox.emailAddress, [
              ...this.addressEntries(input.toAddresses?.length ? input.toAddresses : [input.toAddress]),
              ...this.addressEntries(input.cc ?? []),
              ...this.addressEntries(input.bcc ?? []),
            ]);
          }
          this.logger.log(
            `compose_email DRAFT staged into agent-inbox: message ${msg.id} (workspace ${workspaceId}) pending human approval`,
          );
          await this.recordAction(tx, workspaceId, {
            kind: AgentActionKind.STAGED_FOR_APPROVAL,
            agentKey: input.draftedBy ?? input.externalSource,
            messageId: msg.id,
            actorUcUid: ucUid,
            detail: decision.coerced ? `staged by dial (${decision.reason})` : (input.subject ?? null),
          });
          // Wave 9: notify Stable ONLY for an agent-initiated HELD draft (a send
          // the agent wanted that the gate held for a human). A human "save as
          // draft" (no agent provenance / no hold reasons) is NOT held → no ping.
          // Fired AFTER the tx commits (see the phase-1 return handler below).
          const notify: ApprovalPendingNotice | undefined = held
            ? {
                id: inboxItem.id,
                workspaceId,
                kind: AgentInboxKind.EMAIL,
                summary: itemSummary,
                draftedBy: input.draftedBy ?? input.externalSource,
                reasons: policyReasons,
                toAddress: input.toAddress,
                subject: input.subject,
              }
            : undefined;
          return { done: this.composeView(msg), notify };
        }

        // Wave 7: the transparency footer rides ONLY on an AUTONOMOUS agent send
        // with ≥1 external recipient — a draft a human approves keeps just the
        // normal signature. Applied before the row create so the SoR (and the
        // auto-sent audit feed) shows exactly what left.
        let sendBody = input.body;
        let sendBodyHtml = input.bodyHtml ?? null;
        if (agent && input.transparencyFooter && agentContext) {
          const { external } = splitRecipients(agentContext.recipients, agentContext.internalDomains);
          if (external.length > 0) {
            sendBody = `${sendBody}${input.transparencyFooter.text}`;
            if (sendBodyHtml) sendBodyHtml = `${sendBodyHtml}${input.transparencyFooter.html}`;
          }
        }

        // mode=send — record the SoR row QUEUED now; the external hand-off is
        // phase 2 (outside this tx). The row is durable the instant we commit.
        const msg = await tx.emailMessage.create({
          data: {
            workspaceId,
            mailboxAccountId: mailbox?.id ?? null,
            contactId: input.contactId,
            threadId: input.inReplyToThreadId ?? null,
            inReplyToThreadId: input.inReplyToThreadId ?? null,
            externalSource: input.externalSource,
            externalRef: input.externalRef,
            mode: EmailMode.SEND,
            status: EmailMessageStatus.QUEUED,
            direction: EmailDirection.SENT,
            fromAddress,
            toAddress: input.toAddress,
            subject: input.subject,
            body: sendBody,
            preview: this.snippet(sendBody),
            toAddresses: input.toAddresses?.length ? input.toAddresses : [],
            ccAddresses: input.cc ?? [],
            bccAddresses: input.bcc ?? [],
            bodyHtml: sendBodyHtml,
            attachments: input.attachments?.length
              ? (input.attachments as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
            actorUcUid: ucUid,
          },
        });
        if (mailbox) {
          await this.rememberContacts(tx, workspaceId, mailbox.id, mailbox.emailAddress, [
            ...this.addressEntries(input.toAddresses?.length ? input.toAddresses : [input.toAddress]),
            ...this.addressEntries(input.cc ?? []),
            ...this.addressEntries(input.bcc ?? []),
          ]);
        }
        return {
          send: {
            messageId: msg.id,
            mailbox: mailbox ?? null,
            agentKey: agent?.key ?? null,
            subject: input.subject ?? null,
            req: {
              fromAddress: fromAddress ?? input.toAddress, // engine requires a From; degrade-safe
              fromName: mailbox?.displayName ?? null,
              toAddress: input.toAddress,
              toAddresses: input.toAddresses?.length ? input.toAddresses : undefined,
              subject: input.subject,
              body: sendBody,
              bodyHtml: sendBodyHtml,
              inReplyToThreadId: input.inReplyToThreadId ?? null,
              transactional: mailbox?.postmarkLane ?? true,
              cc: input.cc?.length ? input.cc : undefined,
              bcc: input.bcc?.length ? input.bcc : undefined,
              attachments: input.attachments?.length
                ? input.attachments.map((a) => ({ blobId: a.blob_id, name: a.name, type: a.type }))
                : undefined,
              references: input.references?.length ? input.references : undefined,
              // Wave 7 loop protection: runtime auto-replies are stamped so a
              // receiving agent runtime never answers them back.
              ...(input.agentAutoreply
                ? { headers: [{ name: AGENT_AUTOREPLY_HEADER, value: '1' }] }
                : {}),
            },
          },
        };
      },
    );

    // Idempotent hit OR the draft path: nothing left to send. The staging tx has
    // COMMITTED here, so it is safe to fire the (agent-initiated held) approval
    // ping — a notify failure can no longer roll back mail state.
    if ('done' in prep) {
      if (prep.notify) this.fireApprovalNotice(prep.notify);
      return prep.done;
    }

    // PHASE 1.5 — resolve the REAL Message-ID/References for a reply, OUTSIDE
    // any tx (an external JMAP call). `input.inReplyToMessageId` is an INTERNAL
    // message id (e.g. the id the thread-detail API handed the client) — NOT an
    // RFC Message-ID — so the composer resolves the real threading headers
    // itself. Best-effort: unresolved just means the send goes out without a
    // perfect In-Reply-To/References chain rather than failing.
    if (input.inReplyToMessageId) {
      const resolved = await this.resolveReplyHeaders(
        prep.send.mailbox,
        input.inReplyToMessageId,
        workspaceId,
        ucUid,
      );
      if (resolved?.messageIdHeader) prep.send.req.inReplyTo = resolved.messageIdHeader;
      if (!prep.send.req.references) {
        const chain = [...(resolved?.references ?? []), ...(resolved?.messageIdHeader ? [resolved.messageIdHeader] : [])];
        if (chain.length) prep.send.req.references = chain;
      }
    }

    // PHASE 2 — the external send, OUTSIDE any transaction. callEngine is
    // degrade-clean (a rejected/failed send returns accepted:false, never throws),
    // so a slow or dead provider can't roll back the committed QUEUED row.
    const result = await this.callEngine(prep.send.mailbox, prep.send.req);

    if (result.accepted && input.draftId && prep.send.mailbox) {
      try {
        await this.deleteDraft(workspaceId, ucUid, prep.send.mailbox.id, input.draftId);
      } catch (err) {
        this.logger.warn(
          `compose_email draft cleanup failed for draft ${input.draftId} after send of message ${prep.send.messageId}: ${(err as Error).message}`,
        );
      }
    }

    // PHASE 3 — stamp the outcome onto the QUEUED row + audit an autonomous send
    // (a SHORT tx). The row is already durable; this only advances its status.
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const sent = await this.stampSendResult(tx, prep.send.messageId, result);
      if (prep.send.agentKey) {
        // A registered agent reaching the send lane is an L2 autonomous send (the
        // gate coerces L0/L1 sends to drafts) — audit it WITH its real outcome so
        // the feed never reads a failed autonomous send as a delivered one.
        await this.recordAction(tx, workspaceId, {
          kind: AgentActionKind.AUTONOMOUS_SEND,
          agentKey: prep.send.agentKey,
          messageId: prep.send.messageId,
          actorUcUid: ucUid,
          detail: `${prep.send.subject ?? '(no subject)'} (${this.statusWire(sent.status)})`,
        });
      }
      return this.composeView(sent);
    });
  }

  // ── agent-inbox: list / approve / reject ───────────────────────────────

  /** The agent-inbox queue (PENDING by default), newest-first. */
  async listAgentInbox(
    workspaceId: string,
    ucUid: string | null,
    state?: AgentInboxState,
  ): Promise<AgentInboxView[]> {
    const items = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      return tx.agentInboxItem.findMany({
        // Explicit workspaceId predicate (defense-in-depth: the real fence when
        // RLS is inert under the owner role) + a bound so this hot path — drained
        // on every agent-inbox view and assistant stream — can never turn into an
        // unbounded cross-tenant scan.
        where: { workspaceId, ...(state ? { state } : { state: AgentInboxState.PENDING }) },
        orderBy: { createdAt: 'desc' },
        include: { message: true },
        take: 200,
      });
    });
    // Lazy TARGET BACKFILL: items staged before target-capture existed carry only
    // bare thread_ids, so their approval cards could only say "N threads". Resolve
    // the real subjects on read (bounded, OUTSIDE the tx — the §3 JMAP lesson) and
    // persist, so old pending batches become reviewable too. Degrade-clean.
    await this.backfillNativeCleanupTargets(workspaceId, ucUid, items);
    return items.map((it) => this.inboxView(it, it.message));
  }

  /**
   * Resolve + persist the `targets` preview for up to 3 PENDING native CLEANUP
   * items whose payload predates target-capture (bare thread_ids only). Persists
   * only when at least one subject resolved — a momentarily-dormant engine just
   * retries on a later list instead of freezing a count-only card forever.
   */
  private async backfillNativeCleanupTargets(
    workspaceId: string,
    ucUid: string | null,
    items: Array<{ id: string; state: AgentInboxState; kind: AgentInboxKind; payload: unknown }>,
  ): Promise<void> {
    const isRec = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v);
    const candidates = items
      .filter((it) => {
        if (it.state !== AgentInboxState.PENDING || it.kind !== AgentInboxKind.CLEANUP) return false;
        if (!isRec(it.payload)) return false;
        const p = it.payload;
        return (
          p.native === true &&
          Array.isArray(p.thread_ids) &&
          p.thread_ids.length > 0 &&
          !isRec(p.targets)
        );
      })
      .slice(0, 3);
    for (const it of candidates) {
      try {
        const payload = it.payload as Record<string, unknown>;
        const ids = (payload.thread_ids as unknown[]).map((t) => String(t ?? '').trim()).filter(Boolean);
        const verb =
          String(payload.action ?? '').toUpperCase() === 'TRASH' ? 'Move to Trash' : 'Archive';
        const rows = await this.resolveNativeCleanupTargets(workspaceId, ucUid, ids, MAX_TARGET_ROWS);
        if (rows.length === 0) continue; // engine dormant/rotated — retry next list
        const next = {
          ...payload,
          targets: {
            verb,
            scope: 'threads' as const,
            provider: 'this inbox',
            total: ids.length,
            rows,
            truncated: ids.length > rows.length,
          },
        };
        await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
          // Fenced by id+workspace+state: never rewrites a foreign or already-
          // reviewed item (approval may have raced this resolve).
          tx.agentInboxItem.updateMany({
            where: { id: it.id, workspaceId, state: AgentInboxState.PENDING },
            data: { payload: next as Prisma.InputJsonValue },
          }),
        );
        it.payload = next; // this response already renders the resolved preview
      } catch {
        /* degrade-clean: the card keeps its count-only line until a later list */
      }
    }
  }

  /**
   * Stage a NATIVE bulk-triage batch (Archive/Trash specific threads in the
   * sovereign James inbox) as a PENDING CLEANUP agent-inbox item — the chat's
   * "clean up my inbox" lane for the native mailbox (external Gmail/M365 cleanup
   * goes through the Cleaner Engine's stageCleanupRequest instead). Nothing moves
   * until a human approves; approval both moves the mail in James AND tags the
   * overlay. Dedupes + caps the thread id list. Returns the staged item view (its
   * id backs the confirm card), or null when no valid thread ids were given.
   */
  async stageNativeCleanup(
    workspaceId: string,
    ucUid: string | null,
    disposition: MessageDisposition,
    threadIds: string[],
    opts?: { agentKey?: string | null; reason?: string | null },
  ): Promise<AgentInboxView | null> {
    const ids = Array.from(
      new Set(threadIds.map((t) => String(t ?? '').trim()).filter(Boolean)),
    ).slice(0, 50);
    if (ids.length === 0) return null;
    const folder = this.dispositionFolder(disposition);
    const verb = disposition === MessageDisposition.TRASH ? 'Move to Trash' : 'Archive';
    const summary = `${verb} ${ids.length} thread${ids.length === 1 ? '' : 's'} in your inbox`;
    // Resolve a bounded subject preview BEFORE the tx (JMAP reads must never run
    // inside withWorkspace — the §3 send lesson). Best-effort: an unreachable
    // mailbox yields no rows and the card degrades to the count + verb.
    const rows = await this.resolveNativeCleanupTargets(workspaceId, ucUid, ids, MAX_TARGET_ROWS);
    const targets = {
      verb,
      scope: 'threads' as const,
      provider: 'this inbox',
      total: ids.length,
      rows,
      truncated: ids.length > rows.length,
    };
    // The agent's stated WHY, shown beside the targets on the approval card —
    // "what + why" is the minimum a human needs to trust a destructive batch.
    const reason = String(opts?.reason ?? '').trim().slice(0, 300) || null;
    const draftedBy = opts?.agentKey ?? 'email-ops-assistant';
    const item = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      return tx.agentInboxItem.create({
        data: {
          workspaceId,
          messageId: null,
          kind: AgentInboxKind.CLEANUP,
          // `targets` carries the concrete, bounded preview (subjects) the human
          // sees before approving; the raw thread_ids drive the actual move.
          payload: {
            native: true,
            action: disposition,
            folder,
            thread_ids: ids,
            targets,
            ...(reason ? { reason } : {}),
          },
          state: AgentInboxState.PENDING,
          draftedBy,
          summary,
        },
      });
    });
    // Wave 9: agent-staged cleanup is inherently agent-initiated + destructive —
    // notify Stable AFTER the tx commits. The summary ("Archive N threads …") is
    // the human-facing content; degrade-clean (never affects the staged batch).
    this.fireApprovalNotice({
      id: item.id,
      workspaceId,
      kind: AgentInboxKind.CLEANUP,
      summary,
      draftedBy,
    });
    return this.inboxView(item, null);
  }

  /**
   * Best-effort bounded subject/sender preview for a NATIVE cleanup batch: read the
   * inbox folder of each readable James mailbox once and map the (bounded) requested
   * thread ids to their subject + first participant. Never throws — an unreachable
   * mailbox simply yields fewer rows and the confirm card degrades to the count.
   */
  private async resolveNativeCleanupTargets(
    workspaceId: string,
    ucUid: string | null,
    threadIds: string[],
    limit: number,
  ): Promise<Array<{ subject: string | null; sender: string | null }>> {
    const wanted = threadIds.slice(0, Math.max(0, limit));
    if (wanted.length === 0) return [];
    try {
      const mailboxes = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
        this.readableMailboxes(tx, workspaceId, ucUid),
      );
      const found = new Map<string, { subject: string | null; sender: string | null }>();
      for (const mb of mailboxes) {
        if (this.mailProvider.handles(mb)) continue; // native James mailboxes only
        if (found.size >= wanted.length) break;
        let res: Awaited<ReturnType<StalwartPort['listFolderThreads']>> | null = null;
        try {
          res = await this.stalwart.listFolderThreads(mb.emailAddress, {
            folder: 'inbox',
            limit: 200,
            offset: 0,
          });
        } catch {
          continue; // degrade-clean: skip an unreachable mailbox
        }
        for (const t of res?.threads ?? []) {
          if (!found.has(t.id) && wanted.includes(t.id)) {
            const p = t.participants?.[0] ?? null;
            found.set(t.id, {
              subject: t.subject ?? null,
              sender: p ? (p.name ?? p.address ?? null) : null,
            });
          }
        }
      }
      // Preserve the requested order; drop ids we couldn't resolve.
      return wanted
        .map((id) => found.get(id))
        .filter((row): row is { subject: string | null; sender: string | null } => Boolean(row));
    } catch {
      return [];
    }
  }

  /**
   * Execute an approved NATIVE cleanup batch OUTSIDE any tx (the JMAP moves are
   * external calls — the §3 send-tx lesson): for each thread, move it in James to
   * the target folder (best-effort) AND tag the disposition overlay so the reader
   * reflects the move even when a mailbox is momentarily unreachable. Returns how
   * many threads were moved in James (the overlay is always tagged).
   */
  private async runNativeCleanup(
    workspaceId: string,
    ucUid: string | null,
    disposition: MessageDisposition,
    threadIds: string[],
  ): Promise<number> {
    let moved = 0;
    for (const threadId of threadIds) {
      if (await this.moveThreadToFolderAcrossMailboxes(workspaceId, ucUid, threadId, disposition)) {
        moved += 1;
      }
    }
    await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      for (const threadId of threadIds) {
        await tx.threadDisposition.upsert({
          where: { workspaceId_threadId: { workspaceId, threadId } },
          create: { workspaceId, threadId, disposition, setByUcUid: ucUid, setByAgentKey: 'email-ops-assistant' },
          update: { disposition, setByUcUid: ucUid, setByAgentKey: 'email-ops-assistant' },
        });
      }
    });
    return moved;
  }

  /**
   * Peek an inbox item's kind WITHOUT touching it — the approve front doors use
   * this to route the entitlement gate per kind (EMAIL sends → dual-SKU compose;
   * CLEANUP runs a cleaner batch → cleaner SKU) before delegating the approval.
   * Tenant fence: scope by workspaceId so a foreign item id resolves to null
   * (→ 404) and can NEVER be probed across tenants. RLS is inert under the
   * owner role today, so this explicit predicate is the real guard.
   */
  async peekAgentInboxKind(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
  ): Promise<AgentInboxKind | null> {
    const item = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.agentInboxItem.findFirst({ where: { id: itemId, workspaceId }, select: { kind: true } }),
    );
    return item?.kind ?? null;
  }

  /**
   * Approve a pending agent-inbox draft: PENDING → APPROVED, hand the staged
   * draft to the send lane, advance the message to queued/sent/failed. Returns
   * the updated message view. Idempotent-ish: approving a non-pending item is a
   * no-op that returns the current message view.
   *
   * Wave 7 learning: approving an EMAIL item TEACHES the trusted-correspondent
   * table — every external recipient of the approved send is upserted (source
   * APPROVAL, approvalCount++), so the NEXT in-thread reply to them can flow
   * autonomously ("approve once to trust this correspondent"). Pass
   * `trustRecipients: false` to approve without learning; rejection never learns.
   */
  async approveAgentInboxItem(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
    note?: string | null,
    trustRecipients?: boolean,
  ): Promise<{ inbox: AgentInboxView; message: MessageComposeView | null } | null> {
    // PHASE 1 — validate + authorize (a short tx). A CLEANUP item executes wholly
    // in-tx as before; an EMAIL item resolves its mailbox + returns the send plan,
    // deferring the external send to phase 2 so a slow provider can't time out the
    // tx and roll back the approval for mail that already left (the §3 send bug).
    const prep = await this.prisma.withWorkspace(
      workspaceId,
      ucUid,
      async (tx): Promise<ApprovePrep> => {
        // Tenant fence: scope by workspaceId so a foreign item id resolves to null
        // (→ 404) and can NEVER be acted on across tenants. RLS is inert under the
        // owner role today, so this explicit predicate is the real guard.
        const item = await tx.agentInboxItem.findFirst({
          where: { id: itemId, workspaceId },
          include: { message: true },
        });
        if (!item) return { kind: 'null' };
        if (item.state !== AgentInboxState.PENDING) {
          return {
            kind: 'result',
            value: {
              inbox: this.inboxView(item, item.message),
              message:
                item.kind === AgentInboxKind.EMAIL && item.message
                  ? this.composeView(item.message)
                  : null,
            },
          };
        }

        if (item.kind === AgentInboxKind.CLEANUP) {
          const payload = this.cleanupPayload(item.payload);
          const nativeIds = this.nativeCleanupThreadIds(payload);
          if (nativeIds) {
            // Native bulk-triage: defer execution to AFTER the tx — the JMAP moves
            // are external calls and must not run inside the withWorkspace tx.
            const disposition =
              payload.action === MessageDisposition.TRASH
                ? MessageDisposition.TRASH
                : MessageDisposition.ARCHIVE;
            return {
              kind: 'native-cleanup',
              itemId,
              disposition,
              threadIds: nativeIds,
              draftedBy: item.draftedBy,
            };
          }
          const owner = await this.resolveUserByUcUid(tx, ucUid);
          if (!owner) return { kind: 'null' };
          const batchId = payload.batch_id;
          if (!batchId || typeof batchId !== 'string') return { kind: 'null' };

          const executed = await this.connectedAccounts.approveCleanupBatch(workspaceId, owner, batchId);
          if (!executed) return { kind: 'null' };
          // Truthful UI: only a batch that actually ran flips the item to APPROVED.
          // A failed/disabled/rejected batch must NOT report success — throw with the
          // reason so the approval surface shows the real outcome and the item stays
          // PENDING for a retry or reject (confirm-on-success-only).
          if (!executed.ok || (executed.status !== 'completed' && executed.status !== 'undone')) {
            throw new BadRequestException(
              executed.reason ?? 'The cleanup batch could not be executed — nothing was changed.',
            );
          }

          const updated = await tx.agentInboxItem.update({
            where: { id: itemId },
            data: {
              state: AgentInboxState.APPROVED,
              reviewedByUcUid: ucUid,
              reviewedAt: new Date(),
              reviewNote: note ?? null,
            },
            include: { message: true },
          });
          this.logger.log(
            `agent-inbox cleanup item ${itemId} APPROVED by ${ucUid ?? '(unknown)'} — cleanup batch ${batchId} executed`,
          );
          return { kind: 'result', value: { inbox: this.inboxView(updated, null), message: null } };
        }

        if (!item.message) return { kind: 'null' };

        const mailbox = item.message.mailboxAccountId
          ? await tx.mailboxAccount.findFirst({
              where: { id: item.message.mailboxAccountId, workspaceId },
            })
          : await this.defaultMailbox(tx, workspaceId);

        // Per-user fence: an approved send goes out THROUGH the mailbox owner's
        // identity (for an external box, their KC-broker token). Only the owner may
        // approve a send from a HUMAN mailbox — an approver can't push mail out of a
        // co-member's personal Gmail/M365. SHARED/AGENT boxes stay approvable by any
        // reviewer (the workspace-resource model).
        if (mailbox && !(await this.mayActThroughMailbox(mailbox, ucUid))) {
          throw new ForbiddenException('Only the owner of that mailbox can approve a send from it.');
        }

        return {
          kind: 'send',
          itemId,
          messageId: item.message.id,
          draftedBy: item.draftedBy,
          subject: item.message.subject ?? null,
          mailbox: mailbox ?? null,
          req: {
            fromAddress: item.message.fromAddress ?? mailbox?.emailAddress ?? item.message.toAddress!,
            fromName: mailbox?.displayName ?? null,
            toAddress: item.message.toAddress!,
            // Rebuild the FULL payload the approver reviewed — cc/bcc/multi-recipient/
            // html/attachments were persisted at stage time (the approval-fidelity fix);
            // sending without them would deliver less than was approved.
            toAddresses: item.message.toAddresses?.length ? item.message.toAddresses : undefined,
            cc: item.message.ccAddresses?.length ? item.message.ccAddresses : undefined,
            bcc: item.message.bccAddresses?.length ? item.message.bccAddresses : undefined,
            subject: item.message.subject ?? '',
            body: item.message.body ?? '',
            bodyHtml: item.message.bodyHtml ?? null,
            attachments: this.parseStoredAttachments(item.message.attachments),
            inReplyToThreadId: item.message.inReplyToThreadId ?? null,
            transactional: mailbox?.postmarkLane ?? true,
            // Wave 7 loop protection: an approved runtime draft still leaves as
            // an agent auto-reply — stamp it so no agent runtime answers it back.
            ...(item.message.externalSource === AGENT_REPLY_RUNTIME_SOURCE
              ? { headers: [{ name: AGENT_AUTOREPLY_HEADER, value: '1' }] }
              : {}),
          },
        };
      },
    );

    if (prep.kind === 'null') return null;
    if (prep.kind === 'result') return prep.value;

    if (prep.kind === 'native-cleanup') {
      // Execute the bulk move in James (best-effort per thread) + tag the overlay,
      // all OUTSIDE the authorize tx, then flip the item to APPROVED + audit.
      const moved = await this.runNativeCleanup(workspaceId, ucUid, prep.disposition, prep.threadIds);
      return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
        const updated = await tx.agentInboxItem.update({
          where: { id: prep.itemId },
          data: {
            state: AgentInboxState.APPROVED,
            reviewedByUcUid: ucUid,
            reviewedAt: new Date(),
            reviewNote: note ?? null,
          },
        });
        await this.recordAction(tx, workspaceId, {
          kind: AgentActionKind.APPROVED,
          agentKey: prep.draftedBy,
          messageId: null,
          actorUcUid: ucUid,
          detail: `native cleanup ${prep.disposition}: ${moved}/${prep.threadIds.length} thread(s) moved in James`,
        });
        this.logger.log(
          `agent-inbox native cleanup item ${prep.itemId} APPROVED by ${ucUid ?? '(unknown)'} — ${moved}/${prep.threadIds.length} threads moved in James`,
        );
        return { inbox: this.inboxView(updated, null), message: null };
      });
    }

    // PHASE 2 — hand the approved draft to the mail engine / provider, OUTSIDE the
    // tx (degrade-clean: a failed send returns accepted:false, never throws).
    const result = await this.callEngine(prep.mailbox, prep.req);

    // Wave 7 learning (default ON): the approval vouches for the external
    // recipients. Runs in its OWN fenced call, degrade-clean, so a learning
    // hiccup can never fail an approval whose mail already left.
    if (trustRecipients !== false) {
      await this.learnTrustedCorrespondents(workspaceId, ucUid, prep.draftedBy, [
        ...(prep.req.toAddresses?.length ? prep.req.toAddresses : [prep.req.toAddress]),
        ...(prep.req.cc ?? []),
        ...(prep.req.bcc ?? []),
      ]);
    }

    // PHASE 3 — record the send outcome + transition the item. Confirm-on-success-
    // only (mirrors the cleanup branch above): a send the engine did NOT accept must
    // NOT flip the item to APPROVED, or the approver would believe the reply left when
    // it silently failed. Stamp the failure truthfully on the message, leave the item
    // PENDING, and surface the reason so it can be retried or rejected.
    if (!result.accepted) {
      await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
        await this.stampSendResult(tx, prep.messageId, result);
      });
      this.logger.warn(
        `agent-inbox item ${prep.itemId} NOT approved — send REJECTED for message ${prep.messageId}` +
          `${result.reason ? ` (${result.reason})` : ''}; item stays PENDING for retry`,
      );
      throw new BadRequestException(
        result.reason ?? 'The message could not be sent — nothing was approved. Try again or reject.',
      );
    }

    // The send was accepted — a SHORT tx to stamp SENT + flip the item to APPROVED.
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const sent = await this.stampSendResult(tx, prep.messageId, result);
      const updated = await tx.agentInboxItem.update({
        where: { id: prep.itemId },
        data: {
          state: AgentInboxState.APPROVED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
        include: { message: true },
      });
      this.logger.log(
        `agent-inbox item ${prep.itemId} APPROVED by ${ucUid ?? '(unknown)'} — draft handed to send lane (message ${prep.messageId})`,
      );
      await this.recordAction(tx, workspaceId, {
        kind: AgentActionKind.APPROVED,
        agentKey: prep.draftedBy,
        messageId: prep.messageId,
        actorUcUid: ucUid,
        detail: prep.subject,
      });
      return { inbox: this.inboxView(updated, sent), message: this.composeView(sent) };
    });
  }

  /**
   * Reject a pending agent-inbox draft: PENDING → REJECTED; the message is
   * marked REJECTED and never leaves. No-op (returns current) if not pending.
   */
  async rejectAgentInboxItem(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
    note?: string | null,
  ): Promise<{ inbox: AgentInboxView; message: MessageComposeView | null } | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      // Tenant fence: scope by workspaceId so a foreign item id resolves to null
      // (→ 404) and can NEVER be acted on across tenants. RLS is inert under the
      // owner role today, so this explicit predicate is the real guard.
      const item = await tx.agentInboxItem.findFirst({
        where: { id: itemId, workspaceId },
        include: { message: true },
      });
      if (!item) return null;
      if (item.state !== AgentInboxState.PENDING) {
        return {
          inbox: this.inboxView(item, item.message),
          message: item.kind === AgentInboxKind.EMAIL && item.message ? this.composeView(item.message) : null,
        };
      }
      if (item.kind === AgentInboxKind.CLEANUP) {
        const payload = this.cleanupPayload(item.payload);
        const updated = await tx.agentInboxItem.update({
          where: { id: itemId },
          data: {
            state: AgentInboxState.REJECTED,
            reviewedByUcUid: ucUid,
            reviewedAt: new Date(),
            reviewNote: note ?? null,
          },
          include: { message: true },
        });
        return { inbox: this.inboxView(updated, null), message: null };
      }
      if (!item.message) return null;
      const msg = await tx.emailMessage.update({
        where: { id: item.message.id },
        data: { status: EmailMessageStatus.REJECTED },
      });
      const updated = await tx.agentInboxItem.update({
        where: { id: itemId },
        data: {
          state: AgentInboxState.REJECTED,
          reviewedByUcUid: ucUid,
          reviewedAt: new Date(),
          reviewNote: note ?? null,
        },
      });
      this.logger.log(
        `agent-inbox item ${itemId} REJECTED by ${ucUid ?? '(unknown)'} — message ${item.messageId} will not be sent`,
      );
      await this.recordAction(tx, workspaceId, {
        kind: AgentActionKind.REJECTED,
        agentKey: item.draftedBy,
        messageId: item.message.id,
        actorUcUid: ucUid,
        detail: item.message.subject ?? null,
      });
      return { inbox: this.inboxView(updated, msg), message: this.composeView(msg) };
    });
  }

  // ── Wave 7: the agent-send autonomy matrix support surface ─────────────

  /**
   * Build the pure-matrix context for a REGISTERED agent's requested send:
   * sending-mailbox class (Class B ⇔ an active agent's send identity), internal
   * domains (workspace MailDomain ∪ the agent recipientPolicy), the trusted-
   * correspondent subset of the recipients, and the in-thread-reply-to-inbound
   * proof (runtime attestation OR an SoR RECEIVED row from an external
   * recipient). Runs inside the caller's fenced tx (DB reads only — no engine
   * calls). Lookup failures fall back to a FAIL-SAFE Class-A context (→ the
   * matrix stages a draft); note a hard mid-tx DB failure still aborts the
   * whole compose, which is safer still — nothing sends.
   */
  private async buildAgentComposeContext(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agent: { recipientPolicy: unknown },
    mailbox: MailboxAccount | null,
    input: ComposeInput,
  ): Promise<AgentComposeContext> {
    const attachmentCount = input.attachments?.length ?? 0;
    // EVERY recipient (to + cc + bcc), normalized. bcc counts too — an external
    // bcc is still external mail (the safer side).
    const recipients = [
      ...(input.toAddresses?.length ? input.toAddresses : [input.toAddress]),
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ]
      .map((r) => normalizeAddress(r))
      .filter(Boolean);
    const autonomousSendEnabled = process.env.AGENT_AUTONOMOUS_SEND_ENABLED !== 'false';
    try {
      // Sending-mailbox class: agent-linked (ownerKind AGENT, the denormalized
      // Agent.mailboxAccountId cache, or an AgentMailbox junction row with an
      // active agent) ⇒ Class B; a resolvable non-linked box ⇒ Class A ('user');
      // no mailbox at all ⇒ 'unknown' (treated as Class A by the matrix).
      let mailboxClass: MailboxClass = 'unknown';
      if (mailbox) {
        if ((mailbox.ownerKind as string) === 'AGENT') {
          mailboxClass = 'agent';
        } else {
          const byCache = await tx.agent.findFirst({
            where: { workspaceId, active: true, mailboxAccountId: mailbox.id },
            select: { id: true },
          });
          const byJoin = byCache
            ? null
            : await tx.agentMailbox.findFirst({
                where: { workspaceId, mailboxAccountId: mailbox.id, agent: { active: true } },
                select: { id: true },
              });
          mailboxClass = byCache || byJoin ? 'agent' : 'user';
        }
      }

      const domainRows = await tx.mailDomain.findMany({
        where: { workspaceId },
        select: { domain: true },
      });
      const internalDomains = [
        ...new Set([
          ...domainRows.map((r) => r.domain.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
          ...parseRecipientPolicy(agent.recipientPolicy).internalDomains,
        ]),
      ];

      // A recipient is trusted when its FULL address is trusted (ADDRESS scope)
      // OR its DOMAIN is trusted (DOMAIN scope — "trust everyone @acme.com").
      // We resolve both to the set of effectively-trusted recipient addresses so
      // the downstream all-external-trusted gate (autonomy.ts) is unchanged.
      const domainOf = (addr: string): string => addr.slice(addr.lastIndexOf('@') + 1);
      const recipientDomains = [...new Set(recipients.map(domainOf).filter(Boolean))];
      const trustedRows = recipients.length
        ? await tx.trustedCorrespondent.findMany({
            where: {
              workspaceId,
              OR: [
                { scope: TrustedCorrespondentScope.ADDRESS, address: { in: recipients } },
                { scope: TrustedCorrespondentScope.DOMAIN, address: { in: recipientDomains } },
              ],
            },
            select: { address: true, scope: true },
          })
        : [];
      const trustedExact = new Set(
        trustedRows
          .filter((r) => r.scope === TrustedCorrespondentScope.ADDRESS)
          .map((r) => r.address.toLowerCase()),
      );
      const trustedDomains = new Set(
        trustedRows
          .filter((r) => r.scope === TrustedCorrespondentScope.DOMAIN)
          .map((r) => r.address.toLowerCase()),
      );
      const trustedAddresses = new Set(
        recipients.filter((addr) => {
          const dom = domainOf(addr);
          return trustedExact.has(addr) || (!!dom && trustedDomains.has(dom));
        }),
      );

      // In-thread proof: the runtime attests the inbound it is replying to (it
      // saw the message arrive), OR the SoR carries a RECEIVED row in this
      // thread from one of the external recipients. Anything less = cold.
      const externalSet = new Set(splitRecipients(recipients, internalDomains).external);
      let isInThreadReplyToInbound = false;
      if (input.inReplyToThreadId && externalSet.size > 0) {
        const attested = input.inboundReplyAttestation?.fromAddress
          ? normalizeAddress(input.inboundReplyAttestation.fromAddress)
          : null;
        if (attested && externalSet.has(attested)) {
          isInThreadReplyToInbound = true;
        } else {
          const inbound = await tx.emailMessage.findMany({
            where: {
              workspaceId,
              threadId: input.inReplyToThreadId,
              direction: EmailDirection.RECEIVED,
            },
            select: { fromAddress: true },
            take: 200,
          });
          isInThreadReplyToInbound = inbound.some(
            (r) => r.fromAddress && externalSet.has(normalizeAddress(r.fromAddress)),
          );
        }
      }

      return {
        mailboxClass,
        internalDomains,
        recipients,
        isInThreadReplyToInbound,
        attachmentCount,
        trustedAddresses,
        autonomousSendEnabled,
      };
    } catch (err) {
      this.logger.warn(
        `agent compose context build failed (workspace ${workspaceId}) — FAIL-SAFE Class-A context (send will stage): ${(err as Error).message}`,
      );
      return {
        mailboxClass: 'unknown',
        internalDomains: [],
        recipients,
        isInThreadReplyToInbound: false,
        attachmentCount,
        trustedAddresses: new Set(),
        autonomousSendEnabled,
      };
    }
  }

  /**
   * Approve-path learning (Wave 7): upsert a TrustedCorrespondent row for each
   * EXTERNAL recipient of an approved send (external per the workspace's
   * MailDomain rows; with none bound, everything counts as external — exactly
   * the addresses the gate would hold on). Own fenced call, degrade-clean:
   * learning must never fail an approval whose mail already left.
   */
  private async learnTrustedCorrespondents(
    workspaceId: string,
    ucUid: string | null,
    agentKey: string | null,
    rawRecipients: string[],
  ): Promise<void> {
    try {
      await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
        const domainRows = await tx.mailDomain.findMany({
          where: { workspaceId },
          select: { domain: true },
        });
        const internalDomains = domainRows
          .map((r) => r.domain.trim().toLowerCase().replace(/^@/, ''))
          .filter(Boolean);
        const addresses = [
          ...new Set(rawRecipients.map((r) => normalizeAddress(r)).filter(Boolean)),
        ].filter((addr) => isExternalRecipient(addr, internalDomains));
        const now = new Date();
        for (const address of addresses) {
          // Approval learning is ALWAYS address-exact (ADDRESS scope) — vouching
          // for one person must never silently trust their whole domain.
          await tx.trustedCorrespondent.upsert({
            where: {
              workspaceId_scope_address: {
                workspaceId,
                scope: TrustedCorrespondentScope.ADDRESS,
                address,
              },
            },
            create: {
              workspaceId,
              address,
              scope: TrustedCorrespondentScope.ADDRESS,
              source: TrustedCorrespondentSource.APPROVAL,
              approvalCount: 1,
              lastApprovedAt: now,
              addedByUcUid: ucUid,
              addedByAgentKey: agentKey ?? null,
            },
            update: { approvalCount: { increment: 1 }, lastApprovedAt: now },
          });
        }
        if (addresses.length) {
          this.logger.log(
            `trust learning: approval by ${ucUid ?? '(unknown)'} vouched for ${addresses.length} external correspondent(s) (workspace ${workspaceId})`,
          );
        }
      });
    } catch (err) {
      this.logger.warn(
        `trust learning failed for workspace ${workspaceId} (approval already sent — nothing lost): ${(err as Error).message}`,
      );
    }
  }

  /**
   * The auto-sent audit feed (Wave 7): AUTONOMOUS_SEND events newest-first,
   * each joined to its FULL-fidelity message so the audit surface renders the
   * exact email that left without a human in the loop.
   */
  async listAutoSentFeed(
    workspaceId: string,
    ucUid: string | null,
    limit = 50,
  ): Promise<AutoSentItemView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const events = await tx.agentActionEvent.findMany({
        // Explicit workspaceId predicate (RLS is inert under the owner role) +
        // a hard bound, mirroring listAgentInbox.
        where: { workspaceId, kind: AgentActionKind.AUTONOMOUS_SEND },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(Math.trunc(limit) || 50, 1), 200),
      });
      const ids = [...new Set(events.map((e) => e.messageId).filter((v): v is string => !!v))];
      const messages = ids.length
        ? await tx.emailMessage.findMany({ where: { workspaceId, id: { in: ids } } })
        : [];
      const byId = new Map(messages.map((m) => [m.id, m]));
      return events.map((e) => ({
        id: e.id,
        agentKey: e.agentKey ?? null,
        createdAt: e.createdAt ? e.createdAt.toISOString() : null,
        detail: e.detail ?? null,
        message: e.messageId ? this.messageFullView(byId.get(e.messageId) ?? null) : null,
      }));
    });
  }

  /**
   * One agent-inbox item + the FULL staged message (Wave 7 detail read): the
   * approval surface renders the exact email — both bodies, every recipient,
   * attachment meta — plus payload.policy (why the gate held it). Workspace-
   * fenced like the other item lookups; a foreign id resolves to null (→ 404).
   */
  async getAgentInboxItemDetail(
    workspaceId: string,
    ucUid: string | null,
    itemId: string,
  ): Promise<AgentInboxDetailView | null> {
    const item = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.agentInboxItem.findFirst({
        where: { id: itemId, workspaceId },
        include: { message: true },
      }),
    );
    if (!item) return null;
    return {
      ...this.inboxView(item, item.message),
      message: this.messageFullView(item.message),
    };
  }

  /** An EmailMessage row → the Wave-7 full-fidelity wire shape (null-safe). */
  private messageFullView(
    m: {
      id: string;
      threadId: string | null;
      subject: string | null;
      fromAddress: string | null;
      toAddress: string | null;
      toAddresses: string[];
      ccAddresses: string[];
      bccAddresses: string[];
      body: string | null;
      bodyHtml: string | null;
      attachments: unknown;
      status: EmailMessageStatus;
      mode: EmailMode;
      sentAt: Date | null;
      createdAt: Date;
    } | null,
  ): MessageFullView | null {
    if (!m) return null;
    return {
      id: m.id,
      threadId: m.threadId ?? null,
      subject: m.subject ?? null,
      fromAddress: m.fromAddress ?? null,
      toAddress: m.toAddress ?? null,
      toAddresses: m.toAddresses ?? [],
      ccAddresses: m.ccAddresses ?? [],
      bccAddresses: m.bccAddresses ?? [],
      body: m.body ?? null,
      textBody: m.body ?? null,
      bodyHtml: m.bodyHtml ?? null,
      htmlBody: m.bodyHtml ?? null,
      attachments: this.attachmentsMeta(m.attachments),
      status: this.statusWire(m.status),
      mode: this.modeWire(m.mode),
      sentAt: m.sentAt ? m.sentAt.toISOString() : null,
      createdAt: m.createdAt ? m.createdAt.toISOString() : null,
    };
  }

  /** Stored attachments JSON → display meta [{blobId,name,type,size?}] (tolerant of both key spellings). */
  private attachmentsMeta(
    value: unknown,
  ): { blobId: string | null; name: string | null; type: string | null; size?: number | null }[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a))
      .map((a) => ({
        blobId:
          typeof a.blobId === 'string' ? a.blobId : typeof a.blob_id === 'string' ? a.blob_id : null,
        name: typeof a.name === 'string' ? a.name : null,
        type: typeof a.type === 'string' ? a.type : null,
        ...(typeof a.size === 'number' ? { size: a.size } : {}),
      }));
  }

  /**
   * The mailbox an agent sends FROM. A registered agent uses its OWN primary
   * mailbox (the isPrimary AgentMailbox binding, cached on Agent.mailboxAccountId);
   * an unregistered agent / one with no mailbox falls back to the workspace
   * default — so the legacy + federation path is unchanged.
   */
  private async resolveSendMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    agent: { mailboxAccountId: string | null } | null,
  ) {
    if (agent?.mailboxAccountId) {
      const mb = await tx.mailboxAccount.findFirst({
        where: { id: agent.mailboxAccountId, workspaceId },
      });
      if (mb) return mb;
    }
    return this.defaultMailbox(tx, workspaceId);
  }

  /**
   * Append a row to the agent-mail action/audit log (the activity-feed source).
   * TRANSACTIONAL (not best-effort): it shares the caller's tx, so an event is
   * never recorded for an action that rolled back — and, conversely, an audit
   * INSERT failure rolls the action back (fail-closed; no un-audited action).
   * CAVEAT (compose mode=send): the external handToEngine() runs before this, so
   * a (negligible, single-row-insert) audit failure after a successful external
   * send would roll back the SoR row while the mail already left. Recording the
   * AUTONOMOUS_SEND intent before the engine hand-off is a possible hardening.
   */
  private async recordAction(
    tx: WorkspaceTxClient,
    workspaceId: string,
    data: {
      kind: AgentActionKind;
      agentKey?: string | null;
      messageId?: string | null;
      actorUcUid?: string | null;
      detail?: string | null;
    },
  ): Promise<void> {
    await tx.agentActionEvent.create({
      data: {
        workspaceId,
        kind: data.kind,
        agentKey: data.agentKey ?? null,
        messageId: data.messageId ?? null,
        actorUcUid: data.actorUcUid ?? null,
        detail: data.detail ?? null,
      },
    });
  }

  // ── inbound engagement capture (Phase 2, Part A) ───────────────────────

  /**
   * Record an inbound engagement/delivery signal from the mail engine for a
   * message Email-Ops sent (Postmark today), idempotently + RLS-scoped.
   *
   * THE CRITICAL RLS PATTERN (brief): a provider webhook arrives
   * WORKSPACE-AGNOSTIC. We must NOT widen the RLS bypass to the mutation. So:
   *
   *   1. MINIMAL privileged resolve — a single owner-role / RLS-bypass lookup
   *      that resolves the provider `MessageID` → { id, workspaceId } ONLY. This
   *      is the smallest possible privileged surface: it reads exactly the id +
   *      the owning workspace, nothing else, and never writes. It runs on
   *      `this.prisma` (the base client = the owner connection) deliberately,
   *      because under the live NOBYPASSRLS runtime role a no-GUC read returns 0
   *      rows (fail-closed) and we'd never find the row to scope to.
   *
   *   2. SCOPED mutation — the actual event INSERT + the message status advance
   *      run INSIDE `withWorkspace(resolvedWorkspaceId, …)`, so RLS fences them
   *      to the resolved workspace and the table's WITH CHECK guarantees the row
   *      can only land there. The privileged step never touches a writable
   *      surface; the writable step is always RLS-scoped. The resolve uses
   *      PrismaService.systemClient, the documented ADMIN_DATABASE_URL /
   *      BYPASSRLS side-channel. Do not replace it with the runtime client:
   *      under live NOBYPASSRLS that no-GUC read correctly returns zero rows.
   *
   * IDEMPOTENT: the event is unique on (workspaceId, provider, providerEventId).
   * A re-delivery hits the unique index and is a clean no-op ('duplicate') — no
   * second row, no double/regressed status. The status advance is monotonic
   * (`shouldAdvanceStatus`) so an out-of-order record can't pull a later status
   * back down.
   *
   * UNMATCHED: a signal for a message we didn't send (no row owns the
   * providerMessageId) returns 'unmatched' — the webhook still ACKs 200 so the
   * provider stops retrying (it's not an error, just not ours).
   */
  async recordEngagementEvent(input: EngagementCaptureInput): Promise<EngagementCaptureResult> {
    // ── Step 1: MINIMAL privileged id→workspace resolve (read-only, id-only) ──
    // Resolve the most-recent message carrying this provider id. `select` is
    // restricted to exactly { id, workspaceId, status } — the id+workspace the
    // scoping needs, plus the current status for the monotonic-advance decision.
    // No body, no addressing, no contact — the bypass surface stays minimal.
    const owner = await this.prisma.systemClient.emailMessage.findFirst({
      where: { providerMessageId: input.providerMessageId },
      select: { id: true, workspaceId: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!owner) {
      this.logger.warn(
        `engagement ${input.provider}/${input.recordType} for providerMessageId=${input.providerMessageId} (event ${input.providerEventId}) matched NO Email-Ops message — ACKing as unmatched (not ours)`,
      );
      return {
        outcome: 'unmatched',
        workspaceId: null,
        emailMessageId: null,
        normalizedKind: input.normalizedKind ? input.normalizedKind.toLowerCase() : null,
        statusBefore: null,
        statusAfter: null,
        statusAdvanced: false,
      };
    }

    // ── Step 2: the ACTUAL mutation, RLS-scoped to the resolved workspace ──
    return this.prisma.withWorkspace(owner.workspaceId, null, async (tx) => {
      // Idempotent insert: a re-delivery (same workspace+provider+eventId) is a
      // clean no-op. We pre-check then create; a concurrent racing insert is
      // caught by the unique-constraint guard below (P2002) and also treated as
      // a duplicate, so the path is safe under at-least-once webhook delivery.
      const already = await tx.emailEngagementEvent.findUnique({
        where: {
          workspaceId_provider_providerEventId: {
            workspaceId: owner.workspaceId,
            provider: input.provider,
            providerEventId: input.providerEventId,
          },
        },
        select: { id: true },
      });
      if (already) {
        this.logger.log(
          `engagement ${input.provider} event ${input.providerEventId} already captured for message ${owner.id} (workspace ${owner.workspaceId}) — idempotent no-op`,
        );
        return this.duplicateResult(owner.workspaceId, owner.id, input, owner.status);
      }

      try {
        await tx.emailEngagementEvent.create({
          data: {
            workspaceId: owner.workspaceId,
            emailMessageId: owner.id,
            provider: input.provider,
            providerEventId: input.providerEventId,
            recordType: input.recordType,
            normalizedKind: input.normalizedKind ?? undefined,
            occurredAt: input.occurredAt ?? new Date(),
            raw:
              input.raw === undefined || input.raw === null
                ? undefined
                : (input.raw as Prisma.InputJsonValue),
          },
        });
      } catch (err) {
        // A concurrent insert of the same provider event raced us — treat the
        // unique-violation as the idempotent no-op it is.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          this.logger.log(
            `engagement ${input.provider} event ${input.providerEventId} raced a concurrent capture for message ${owner.id} — idempotent no-op`,
          );
          return this.duplicateResult(owner.workspaceId, owner.id, input, owner.status);
        }
        throw err;
      }

      // Monotonic status advance: never regress a later status (the webhook is
      // the only non-regressing writer; see message-status.ts).
      const before = owner.status;
      const advance = shouldAdvanceStatus(before, input.statusTarget);
      let after = before;
      if (input.statusTarget && advance) {
        const updated = await tx.emailMessage.update({
          where: { id: owner.id },
          data: { status: input.statusTarget },
          select: { status: true },
        });
        after = updated.status;
        this.logger.log(
          `engagement ${input.provider}/${input.recordType} advanced message ${owner.id} status ${before} → ${after} (workspace ${owner.workspaceId})`,
        );
      } else if (input.statusTarget && !advance) {
        this.logger.log(
          `engagement ${input.provider}/${input.recordType} for message ${owner.id} implies ${input.statusTarget} but current ${before} is >= that rung — status held (non-regressing)`,
        );
      }

      return {
        outcome: 'recorded' as const,
        workspaceId: owner.workspaceId,
        emailMessageId: owner.id,
        normalizedKind: input.normalizedKind ? input.normalizedKind.toLowerCase() : null,
        statusBefore: before.toLowerCase(),
        statusAfter: after.toLowerCase(),
        statusAdvanced: after !== before,
      };
    });
  }

  /** Shared shape for an idempotent-duplicate engagement capture (no change). */
  private duplicateResult(
    workspaceId: string,
    emailMessageId: string,
    input: EngagementCaptureInput,
    currentStatus: EmailMessageStatus,
  ): EngagementCaptureResult {
    return {
      outcome: 'duplicate',
      workspaceId,
      emailMessageId,
      normalizedKind: input.normalizedKind ? input.normalizedKind.toLowerCase() : null,
      statusBefore: currentStatus.toLowerCase(),
      statusAfter: currentStatus.toLowerCase(),
      statusAdvanced: false,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Call the mail engine / external provider to actually send. This is PURE
   * external work (NO database access) so it runs OUTSIDE the withWorkspace
   * interactive transaction — a slow provider send (Gmail/Graph, >5s) must not
   * hold the Prisma tx open past its timeout and roll back the SoR row for mail
   * that already DELIVERED (the §3 send-transaction-timeout bug). Degrade-clean:
   * a failure returns accepted:false (never throws); the caller records FAILED.
   *
   * External account (gmail / microsoft) → its provider API; the sovereign
   * mailbox → Stalwart/Postmark. The result is normalized across both.
   */
  /**
   * Resolve a reply's REAL threading headers from an INTERNAL message id (the
   * webmail wave's in_reply_to contract: the client sends the id from its
   * thread-detail API, not an RFC Message-ID). Tries the id directly as a JMAP
   * email id first (covers replying to received mail, or mail already sent via
   * JMAP); falls back to resolving it as one of OUR OWN local SoR row ids and
   * retrying with that row's providerMessageId. Degrade-clean: null when
   * unresolved (the composer then sends without perfect threading headers).
   */
  private async resolveReplyHeaders(
    mailbox: MailboxAccount | null,
    internalId: string,
    workspaceId: string,
    ucUid: string | null,
  ): Promise<{ messageIdHeader: string | null; references: string[] | null } | null> {
    if (!mailbox) return null;
    const direct = await this.stalwart.getMessageHeaders(mailbox.emailAddress, internalId);
    if (direct) return direct;
    const row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.emailMessage.findFirst({
        where: { id: internalId, workspaceId },
        select: { providerMessageId: true },
      }),
    );
    if (row?.providerMessageId) {
      return this.stalwart.getMessageHeaders(mailbox.emailAddress, row.providerMessageId);
    }
    return null;
  }

    private async callEngine(mailbox: MailboxAccount | null, req: SendReq): Promise<EngineSendResult> {
    if (mailbox && this.mailProvider.handles(mailbox)) {
      // The external-provider send path (Gmail/M365) does not carry attachments yet.
      // Fail loud rather than deliver a message that silently dropped its attachment —
      // accepted:true with a missing file is worse than a clear failure. (In practice
      // uploadAttachment returns null for provider mailboxes, so req.attachments is
      // normally empty; this guards a stale/forged ref or a post-engine-switch draft.)
      if (req.attachments?.length) {
        return {
          accepted: false,
          providerMessageId: null,
          threadId: req.inReplyToThreadId ?? null,
          lane: null,
          reason: `attachments are not supported for ${mailbox.provider} sends yet — nothing was sent`,
        };
      }
      const r = await this.mailProvider.send(mailbox, {
        from: req.fromAddress,
        to: req.toAddress,
        subject: req.subject,
        body: req.body,
        inReplyToThreadId: req.inReplyToThreadId,
      });
      return {
        accepted: r.accepted,
        providerMessageId: r.providerMessageId,
        threadId: r.threadId,
        lane: r.accepted ? mailbox.provider : null,
        reason: r.reason,
      };
    }
    const r = await this.stalwart.send(
      req.fromAddress,
      {
        fromAddress: req.fromAddress,
        fromName: req.fromName,
        toAddress: req.toAddress,
        toAddresses: req.toAddresses,
        subject: req.subject,
        body: req.body,
        bodyHtml: req.bodyHtml ?? null,
        inReplyToThreadId: req.inReplyToThreadId,
        cc: req.cc,
        bcc: req.bcc,
        attachments: req.attachments,
        inReplyTo: req.inReplyTo,
        references: req.references,
        headers: req.headers,
      },
      req.transactional,
    );
    return {
      accepted: r.accepted,
      providerMessageId: r.providerMessageId,
      threadId: r.threadId,
      lane: r.lane,
      reason: r.reason ?? null,
    };
  }

  /**
   * Persist a callEngine() result onto the SoR row (status SENT/FAILED + the
   * provider id + thread + sentAt). Runs inside the caller's SHORT post-send tx.
   * The row is already durable (recorded QUEUED before the send); this only
   * advances its status — so a slow send never risked rolling the row back.
   */
  private async stampSendResult(
    tx: WorkspaceTxClient,
    messageId: string,
    result: EngineSendResult,
  ) {
    const status = result.accepted ? EmailMessageStatus.SENT : EmailMessageStatus.FAILED;
    if (!result.accepted) {
      this.logger.warn(
        `message ${messageId} send NOT accepted by mail engine (lane=${result.lane ?? 'none'}): ${result.reason ?? 'unknown'} — recorded FAILED (degrade-clean)`,
      );
    }
    return tx.emailMessage.update({
      where: { id: messageId },
      data: {
        status,
        providerMessageId: result.providerMessageId,
        threadId: result.threadId ?? undefined,
        sentAt: result.accepted ? new Date() : null,
      },
    });
  }

  /** The workspace's default mailbox account, or null. Explicitly tenant-scoped
   * (RLS is inert under the owner role) so a mailbox-less workspace can NEVER fall
   * back to another tenant's mailbox as its send identity. */
  private async defaultMailbox(tx: WorkspaceTxClient, workspaceId: string) {
    const def = await tx.mailboxAccount.findFirst({
      where: { workspaceId, isDefault: true, active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (def) return def;
    return tx.mailboxAccount.findFirst({
      where: { workspaceId, active: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async resolveUserByUcUid(tx: WorkspaceTxClient, ucUid: string | null) {
    if (!ucUid) return null;
    return tx.user.findFirst({
      where: {
        OR: [{ keycloakId: ucUid }, { id: ucUid }],
      },
    });
  }

  /**
   * Resolve a contact's deliverable address. Contact-Ops is the canonical
   * phonebook (federated), but Email-Ops doesn't store contacts; for the read
   * path we use the most recent outbound `toAddress` we recorded for this
   * contact as the address hint (a brand-new contact with no history yields null
   * and the live-thread lookup is skipped — degrade-clean).
   */
  private async contactAddress(
    tx: WorkspaceTxClient,
    workspaceId: string,
    contactId: string,
  ): Promise<string | null> {
    const last = await tx.emailMessage.findFirst({
      where: { workspaceId, contactId, toAddress: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { toAddress: true },
    });
    return last?.toAddress ?? null;
  }

  private addressEntries(addresses: string[]): { email: string; displayName: string | null }[] {
    return addresses
      .map((raw) => {
        const match = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/);
        const email = (match?.[2] ?? raw).trim().toLowerCase();
        const displayName = (match?.[1] ?? '').trim() || null;
        return { email, displayName };
      })
      .filter((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email));
  }

  private async rememberContactsFromMessages(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxId: string,
    mailboxAddress: string,
    messages: MessageView[],
  ): Promise<void> {
    const entries = messages.flatMap((m) => [
      ...(m.from ? [{ email: m.from.address, displayName: m.from.name }] : []),
      ...m.to.map((p) => ({ email: p.address, displayName: p.name })),
      ...(m.cc ?? []).map((p) => ({ email: p.address, displayName: p.name })),
    ]);
    await this.rememberContacts(tx, workspaceId, mailboxId, mailboxAddress, entries);
  }

  private async rememberContacts(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxId: string,
    mailboxAddress: string,
    entries: { email: string; displayName: string | null }[],
  ): Promise<void> {
    const own = mailboxAddress.trim().toLowerCase();
    const now = new Date();
    const byEmail = new Map<string, { email: string; displayName: string | null }>();
    for (const entry of entries) {
      const email = entry.email.trim().toLowerCase();
      if (!email || email === own || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      const existing = byEmail.get(email);
      if (!existing || (!existing.displayName && entry.displayName)) {
        byEmail.set(email, { email, displayName: entry.displayName?.trim() || null });
      }
    }
    for (const entry of byEmail.values()) {
      await tx.mailContact.upsert({
        where: {
          workspaceId_mailboxAccountId_email: {
            workspaceId,
            mailboxAccountId: mailboxId,
            email: entry.email,
          },
        },
        create: {
          workspaceId,
          mailboxAccountId: mailboxId,
          email: entry.email,
          displayName: entry.displayName,
          lastSeenAt: now,
          frequency: 1,
        },
        update: {
          ...(entry.displayName ? { displayName: entry.displayName } : {}),
          lastSeenAt: now,
          frequency: { increment: 1 },
        },
      });
    }
  }

  /** StalwartMessageDetail -> the enriched MessageView wire shape (webmail-wave thread-detail). */
  private toDetailedMessageView(m: StalwartMessageDetail): MessageView {
    return {
      id: m.id,
      thread_id: m.threadId,
      from: m.from ? { address: m.from.address, name: m.from.name } : null,
      to: m.to.map((p) => ({ address: p.address, name: p.name })),
      subject: m.subject,
      sent_at: m.sentAt,
      preview: m.preview,
      direction: m.direction,
      cc: m.cc.map((p) => ({ address: p.address, name: p.name })),
      bcc: m.bcc.map((p) => ({ address: p.address, name: p.name })),
      html_body: m.htmlBody,
      text_body: m.textBody,
      message_id_header: m.messageIdHeader,
      references: m.references,
      is_unread: m.isUnread,
      flagged: m.flagged,
      attachments: m.attachments.map((a) => ({
        blob_id: a.blobId,
        name: a.name,
        type: a.type,
        size: a.size,
        cid: a.cid,
      })),
    };
  }

  private composeView(m: {
    id: string;
    threadId: string | null;
    status: EmailMessageStatus;
    mode: EmailMode;
    externalSource: string | null;
    externalRef: string | null;
    createdAt: Date;
  }): MessageComposeView {
    return {
      id: m.id,
      thread_id: m.threadId ?? null,
      status: this.statusWire(m.status),
      mode: this.modeWire(m.mode),
      external_source: m.externalSource ?? null,
      external_ref: m.externalRef ?? null,
      created_at: m.createdAt ? m.createdAt.toISOString() : null,
    };
  }

  private inboxView(
    it: {
      id: string;
      messageId: string | null;
      kind?: AgentInboxKind;
      payload?: unknown;
      state: AgentInboxState;
      draftedBy: string | null;
      summary: string | null;
      reviewedByUcUid: string | null;
      reviewedAt: Date | null;
      reviewNote: string | null;
      createdAt: Date;
    },
    msg: {
      toAddress: string | null;
      subject: string | null;
      body?: string | null;
      preview?: string | null;
    } | null,
  ): AgentInboxView {
    const payload = this.cleanupPayload(it.payload);
    const isCleanup = it.kind === AgentInboxKind.CLEANUP;
    return {
      id: it.id,
      message_id: it.messageId,
      kind: it.kind ?? 'EMAIL',
      state: it.state.toLowerCase(),
      drafted_by: it.draftedBy ?? null,
      summary: it.summary ?? (isCleanup ? this.cleanupSummary(payload) : null),
      to_address: isCleanup ? null : msg?.toAddress ?? null,
      subject: isCleanup ? this.cleanupSubject(payload) : msg?.subject ?? null,
      body_preview: isCleanup
        ? this.cleanupBodyPreview(payload)
        : msg
          ? msg.preview ?? this.snippet(msg.body)
          : null,
      reviewed_by_uc_uid: it.reviewedByUcUid ?? null,
      reviewed_at: it.reviewedAt ? it.reviewedAt.toISOString() : null,
      review_note: it.reviewNote ?? null,
      created_at: it.createdAt ? it.createdAt.toISOString() : null,
      // Wave 7: EMAIL items now carry payload too (payload.policy — why the
      // gate held the send). Additive: pre-wave EMAIL items had a null payload
      // in the DB, so they keep rendering null here.
      payload: isCleanup || (it.payload && typeof it.payload === 'object') ? payload : null,
    };
  }

  private snippet(body: string | null | undefined): string | null {
    if (!body) return null;
    const flat = body.replace(/\s+/g, ' ').trim();
    return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
  }

  private summary(subject: string | null | undefined, to: string | null | undefined): string {
    const s = subject?.trim() || '(no subject)';
    return to ? `${s} → ${to}` : s;
  }

  private cleanupPayload(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  /** Threads targeted by a NATIVE bulk-triage cleanup payload (else null). */
  private nativeCleanupThreadIds(payload: Record<string, unknown>): string[] | null {
    if (payload.native !== true) return null;
    const ids = payload.thread_ids;
    return Array.isArray(ids) ? ids.map((t) => String(t)).filter(Boolean) : [];
  }

  private cleanupSummary(payload: Record<string, unknown>): string | null {
    const nativeIds = this.nativeCleanupThreadIds(payload);
    if (nativeIds) {
      const verb = payload.action === MessageDisposition.TRASH ? 'Move to Trash' : 'Archive';
      return `${verb} ${nativeIds.length} thread${nativeIds.length === 1 ? '' : 's'} in your inbox`;
    }
    const action = typeof payload.action === 'string' ? payload.action : 'cleanup';
    const provider = typeof payload.provider === 'string' ? payload.provider : '';
    const count = Array.isArray((payload.plan as Record<string, unknown> | undefined)?.safe)
      ? ((payload.plan as Record<string, unknown>).safe as unknown[]).length
      : 0;
    return `${action}${provider ? ` on ${provider}` : ''}${count ? ` (${count} safe)` : ''}`;
  }

  private cleanupSubject(payload: Record<string, unknown>): string | null {
    if (this.nativeCleanupThreadIds(payload)) {
      return payload.action === MessageDisposition.TRASH ? 'Trash threads' : 'Archive threads';
    }
    const action = typeof payload.action === 'string' ? payload.action : 'Cleanup';
    return `${action[0]?.toUpperCase() ?? 'C'}${action.slice(1)} request`;
  }

  private cleanupBodyPreview(payload: Record<string, unknown>): string | null {
    const nativeIds = this.nativeCleanupThreadIds(payload);
    if (nativeIds) {
      const verb = payload.action === MessageDisposition.TRASH ? 'trashed' : 'archived';
      return `${nativeIds.length} thread${nativeIds.length === 1 ? '' : 's'} will be ${verb} in your James mailbox on approval.`;
    }
    const plan = payload.plan && typeof payload.plan === 'object' ? (payload.plan as Record<string, unknown>) : null;
    const safe = Array.isArray(plan?.safe) ? (plan?.safe as Array<Record<string, unknown>>) : [];
    const protectedCount = Array.isArray(plan?.protected) ? (plan?.protected as unknown[]).length : 0;
    return `${safe.length} safe · ${protectedCount} protected`;
  }

  /** Surfaced for a future REST seam / tests that want a Prisma type alias. */
  static readonly _txType: Prisma.TransactionClient | undefined = undefined;
}
