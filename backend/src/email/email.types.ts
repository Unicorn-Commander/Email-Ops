/**
 * Email-Ops wire shapes — the EmailOpsPort federation contract.
 *
 * BINDING: these snake_case shapes MUST match the contract Customer-Ops calls
 * (its backend/src/email-ops/email-ops.types.ts + email-ops.client.ts) so the
 * cockpit federates Email-Ops for real. The MCP server emits exactly these as
 * the tool `structuredContent`:
 *   - list_threads_with_contact -> { threads: ThreadView[] }
 *   - list_thread_messages      -> { messages: MessageView[] }
 *   - compose_email             -> MessageComposeView
 *
 * The cockpit's client maps `message_count`→messageCount, `last_message_at`→
 * lastMessageAt, etc. — so the field NAMES below are load-bearing. The
 * webmail-wave additions (unread/has_attachments/html_body/etc.) are ADDITIVE
 * ONLY — existing consumers that don't know these fields simply ignore them.
 */

import { MessageDisposition } from '@prisma/client';

/**
 * The stable provenance slug of the agent-reply runtime (Wave 7). Defined here
 * (not imported from agent-reply.service) so EmailService can recognize
 * runtime-initiated composes without an import cycle; agent-reply.service
 * re-exports it as AGENT_REPLY_SOURCE.
 */
export const AGENT_REPLY_RUNTIME_SOURCE = 'agent-reply-runtime';

/**
 * A client mail folder. The disposition folders (inbox/archive/trash/spam) are
 * the overlay; sent/drafts derive from the SoR direction/status.
 */
export type MailFolder = 'inbox' | 'archive' | 'spam' | 'trash' | 'sent' | 'drafts';

/** One participant on a thread/message (a from/to/cc address). */
export interface ParticipantView {
  address: string;
  name: string | null;
}

/** A mailbox thread with a contact (the customer-360 email history row). */
export interface ThreadView {
  id: string;
  subject: string | null;
  message_count: number;
  unread: boolean;
  flagged?: boolean;
  last_message_at: string | null;
  last_snippet: string | null;
  participants: ParticipantView[];
  // The app-layer folder placement (the disposition overlay; default INBOX).
  // Optional on the shared federation contract — populated by the client BFF
  // (listMailboxInbox); the customer-360 contact-history surface omits it.
  disposition?: MessageDisposition;
  // webmail wave: cheaply-derived attachment presence (JMAP `hasAttachment`).
  // Omitted (not `false`) when the data source can't answer it for free.
  has_attachments?: boolean;
  // webmail wave (unified inbox aggregate only): which mailbox this thread
  // belongs to, so the client can render/act on it in a merged list.
  mailbox_id?: string;
  mailbox_address?: string;
}

/** One attachment on a message (webmail wave: thread-detail enrichment). */
export interface AttachmentView {
  blob_id: string;
  name: string | null;
  type: string | null;
  size: number | null;
  /** Content-ID for an inline image (matches an <img cid:...> reference); null otherwise. */
  cid: string | null;
}

/** One message within a thread (bodies as previews only, PLUS the webmail-wave detail fields). */
export interface MessageView {
  id: string;
  thread_id: string;
  from: ParticipantView | null;
  to: ParticipantView[];
  subject: string | null;
  sent_at: string | null;
  preview: string | null;
  direction: string; // received | sent | draft
  // webmail wave — thread-detail enrichment (additive; undefined when not
  // sourced from the live JMAP/engine path, e.g. a thin local-only SoR row).
  cc?: ParticipantView[];
  bcc?: ParticipantView[];
  /** Raw HTML body — NOT sanitized server-side; the client sanitizes on render. */
  html_body?: string | null;
  text_body?: string | null;
  message_id_header?: string | null;
  references?: string[] | null;
  is_unread?: boolean;
  flagged?: boolean;
  attachments?: AttachmentView[];
}

/**
 * The result of a compose (send/draft). Echoed back so the cockpit caches a thin
 * projection on its link row. IDEMPOTENT: a repeat with the same
 * (workspace_id, external_source, external_ref) returns the EXISTING message.
 */
export interface MessageComposeView {
  id: string;
  thread_id: string | null;
  status: string; // queued|sent|delivered|draft|pending_approval|rejected|failed
  mode: string; // send | draft
  external_source: string | null;
  external_ref: string | null;
  created_at: string | null;
}

/** One uploaded compose attachment reference (webmail wave: compose extension). */
export interface ComposeAttachmentInput {
  blob_id: string;
  name: string;
  type: string;
}

/** Internal: the parsed compose request the service acts on. */
export interface ComposeInput {
  contactId: string | null;
  toAddress: string;
  /**
   * The full recipient list (webmail wave: `to_address` may arrive comma-joined
   * from the client — the controller splits it here). When present + non-empty
   * this is authoritative for the actual send; `toAddress` stays its first
   * entry (the back-compat single-recipient field used for the SoR row / the
   * federation contract).
   */
  toAddresses?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  mode: 'send' | 'draft';
  inReplyToThreadId?: string | null;
  externalSource: string;
  externalRef: string;
  draftedBy?: string | null;
  /**
   * Explicit send-from mailbox (the human email client picks which inbox to send
   * as). When set + in-workspace, it overrides the agent/default send-identity
   * resolution; otherwise the usual resolveSendMailbox path applies.
   */
  fromMailboxAccountId?: string | null;
  // webmail wave — compose extension (all optional, back-compat). Carried
  // through to the mail engine's send lane (StalwartPort); see
  // JamesClient.send for the attachment-routing deviation (JMAP, not Postmark).
  cc?: string[];
  bcc?: string[];
  attachments?: ComposeAttachmentInput[];
  /** The Message-ID header of the message being replied to (for In-Reply-To threading). */
  inReplyToMessageId?: string | null;
  /** The References header chain (oldest first). */
  references?: string[];
  /** The server-side draft id to update/delete for persistent drafts. */
  draftId?: string | null;
  // ── Wave 7 (agent-send autonomy matrix) — INTERNAL fields. Set only by
  // first-party runtimes (the agent-reply runtime); the REST/MCP controllers
  // never map them from wire input, so an external caller cannot forge them.
  /** Stamp the outbound with X-UC-Agent-Autoreply: 1 (runtime loop protection). */
  agentAutoreply?: boolean;
  /**
   * First-party attestation that this compose is an in-thread reply to a REAL
   * inbound message from `fromAddress` (the runtime saw it arrive). Feeds the
   * matrix's not-cold-outbound proof alongside the SoR inbound-row check.
   */
  inboundReplyAttestation?: { fromAddress: string } | null;
  /**
   * Upstream policy holds (e.g. the runtime's thread-rate-cap): when the
   * effective mode is 'draft', these merge into the staged item's
   * payload.policy.reasons so the approver sees WHY it was held.
   */
  policyReasons?: { code: string; message: string }[];
  /**
   * The transparency footer to append ONLY when the gate decides an AUTONOMOUS
   * SEND with ≥1 external recipient ("— <Agent> · AI agent, sent autonomously").
   * Drafts a human approves keep just the normal signature (never appended).
   */
  transparencyFooter?: { text: string; html: string } | null;
}

/** An agent-inbox item view (the approval queue surface). */
export interface AgentInboxView {
  id: string;
  message_id: string | null;
  kind?: string;
  state: string; // pending | approved | rejected
  drafted_by: string | null;
  summary: string | null;
  to_address: string | null;
  subject: string | null;
  // A short preview of the drafted BODY so the reviewer sees what the agent
  // actually wrote without opening the full message (Email-Ops' own agent-inbox
  // surface — NOT the federation contract, which is the 3 EmailOpsPort tools).
  body_preview: string | null;
  reviewed_by_uc_uid: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * The agent-inbox item DETAIL (Wave 7): the queue row + the FULL staged message
 * (html/text body, all recipients, attachment meta) so the approver reviews the
 * exact email — plus payload (which carries payload.policy hold reasons).
 */
export interface AgentInboxDetailView extends AgentInboxView {
  message: MessageFullView | null;
}

/**
 * The FULL staged/sent message detail (Wave 7 pinned contract): everything the
 * UI needs to render the exact email — recipients, both bodies, attachment meta.
 * camelCase per the Wave-7 frontend contract (deliberately unlike the snake_case
 * federation shapes above — this is the cockpit's own surface, pinned as such).
 */
export interface MessageFullView {
  id: string;
  threadId: string | null;
  subject: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  /** Plain-text body (also mirrored as textBody — both spellings pinned). */
  body: string | null;
  textBody: string | null;
  /** HTML body (also mirrored as htmlBody — both spellings pinned). */
  bodyHtml: string | null;
  htmlBody: string | null;
  attachments: {
    blobId: string | null;
    name: string | null;
    type: string | null;
    size?: number | null;
  }[];
  status: string;
  mode: string;
  sentAt: string | null;
  createdAt: string | null;
}

/** One row of the auto-sent audit feed (Wave 7 pinned contract). */
export interface AutoSentItemView {
  id: string;
  agentKey: string | null;
  createdAt: string | null;
  detail: string | null;
  message: MessageFullView | null;
}

/** One trusted correspondent row (Wave 7 pinned contract; camelCase). */
export interface TrustedCorrespondentView {
  id: string;
  address: string;
  /** 'ADDRESS' (one address) or 'DOMAIN' (every address at a bare domain). */
  scope: string;
  source: string;
  approvalCount: number;
  lastApprovedAt: string | null;
  addedByUcUid: string | null;
  note: string | null;
  createdAt: string | null;
}

/**
 * Internal: a normalized inbound engagement signal the webhook layer hands to
 * EmailService.recordEngagementEvent. The webhook (Part A) has already mapped a
 * raw provider record to this shape; the service performs the privileged
 * id→workspace resolve and the RLS-scoped idempotent persist + status advance.
 *
 * `providerMessageId` is the engine's message id (Postmark `MessageID`) used to
 * resolve the owning EmailMessage → its workspaceId. `providerEventId` is the
 * provider's dedupe key for THIS record (the idempotency anchor). `statusTarget`
 * is the EmailMessageStatus this record implies (null = engagement-only, no
 * status change). `normalizedKind` is the suite engagement kind (null when the
 * record maps to none, e.g. a bare Delivery).
 */
export interface EngagementCaptureInput {
  provider: string; // 'postmark'
  providerMessageId: string;
  providerEventId: string;
  recordType: string; // verbatim provider RecordType
  normalizedKind: import('@prisma/client').EmailEngagementKind | null;
  statusTarget: import('@prisma/client').EmailMessageStatus | null;
  occurredAt: Date | null;
  raw: unknown;
}

/**
 * The outcome of recording an engagement signal. `outcome`:
 *   - 'recorded'   : a new event row was written (+ maybe a status advance).
 *   - 'duplicate'  : the (workspace, provider, providerEventId) was already seen
 *                    — a webhook re-delivery; nothing changed (idempotent no-op).
 *   - 'unmatched'  : no EmailMessage owns this providerMessageId (a signal for a
 *                    message Email-Ops didn't send, or sent before capture) — the
 *                    webhook still ACKs 200 so the provider stops retrying.
 */
export interface EngagementCaptureResult {
  outcome: 'recorded' | 'duplicate' | 'unmatched';
  workspaceId: string | null;
  emailMessageId: string | null;
  normalizedKind: string | null; // the wire vocabulary (lowercased), or null
  statusBefore: string | null;
  statusAfter: string | null;
  statusAdvanced: boolean;
}

/** One mailbox's Inbox unread/total counts (webmail wave: counts surface). */
export interface MailboxCountsView {
  mailbox_id: string;
  address: string;
  inbox_unread: number;
  inbox_total: number;
  /** True when the engine call for THIS mailbox failed (zeros above are a placeholder, not real). */
  error?: boolean;
}

/** The webmail-wave bulk thread action kinds (archive/trash/spam/inbox reuse DispositionService; read/unread reuse the $seen toggle). */
export type BulkThreadAction = 'archive' | 'trash' | 'spam' | 'inbox' | 'read' | 'unread';

/** The per-thread outcome of a bulk action (webmail wave). */
export interface BulkActionResult {
  succeeded: string[];
  failed: string[];
}
