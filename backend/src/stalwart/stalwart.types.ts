/**
 * The Stalwart mail-engine wire shapes.
 *
 * Email-Ops FRONTS the Stalwart mail server (IMAP/JMAP) for mailbox state +
 * threads (SUITE-ARCHITECTURE-MAP §3: Stalwart = "Mail server (IMAP/JMAP) —
 * mailboxes/receiving", fronted by Email-Ops). These are the shapes the
 * StalwartPort returns to the Email-Ops service layer; the service maps them
 * onto the SoR rows + the EmailOpsPort federation contract.
 *
 * "Federate the engine, don't reinvent a mail server": these shapes are
 * informed by JMAP (Thread / Email objects) so Stalwart's native model maps
 * cleanly. Transactional OUTBOUND routes via Postmark (the high-rep lane); the
 * mailbox read path is Stalwart.
 */

/** One from/to/cc participant on a thread or message (a JMAP EmailAddress). */
export interface StalwartParticipant {
  address: string;
  name: string | null;
}

/** A mailbox thread (a JMAP Thread / IMAP conversation). */
export interface StalwartThread {
  /** The provider thread id (JMAP threadId). Opaque above this layer. */
  id: string;
  subject: string | null;
  messageCount: number;
  unread: boolean;
  flagged?: boolean;
  /** ISO-8601 of the most recent message in the thread. */
  lastMessageAt: string | null;
  /** A short snippet/preview of the latest message (no full body). */
  lastSnippet: string | null;
  /** The distinct participants across the thread (deduped). */
  participants: StalwartParticipant[];
  /**
   * Whether any message in the thread carries an attachment. Optional: only
   * populated where cheaply derivable (JMAP's `hasAttachment` Email property) —
   * omitted rather than guessed when the engine doesn't hand it over for free.
   */
  hasAttachments?: boolean;
}

/** One message in a thread (a JMAP Email / IMAP message). Bodies are previews. */
export interface StalwartMessage {
  id: string;
  threadId: string;
  from: StalwartParticipant | null;
  to: StalwartParticipant[];
  subject: string | null;
  /** ISO-8601 sent/received time. */
  sentAt: string | null;
  /** A preview/snippet of the body (NOT the full message). */
  preview: string | null;
  /** received | sent | draft (the message's direction/state in the mailbox). */
  direction: 'received' | 'sent' | 'draft';
}

/** One attachment on a message (a JMAP Email bodyStructure part). */
export interface StalwartAttachment {
  blobId: string;
  name: string | null;
  type: string | null;
  size: number | null;
  /** Content-ID for an inline image (matched to an <img cid:...> reference); null otherwise. */
  cid: string | null;
}

/**
 * The FULL detail of one message in a thread (the thread-detail enrichment):
 * bodies (raw HTML — the client sanitizes), full participant lists, threading
 * headers, read state, and attachments. A superset of StalwartMessage.
 */
export interface StalwartMessageDetail extends StalwartMessage {
  cc: StalwartParticipant[];
  bcc: StalwartParticipant[];
  /** Raw HTML body (NOT sanitized server-side — the client sanitizes on render). */
  htmlBody: string | null;
  textBody: string | null;
  /** The Message-ID header value (as returned by the engine; may or may not carry the surrounding <>). */
  messageIdHeader: string | null;
  /** The References header, as a list of Message-IDs (oldest first), when available. */
  references: string[] | null;
  isUnread: boolean;
  flagged: boolean;
  attachments: StalwartAttachment[];
}

/** A folder + search + paging query against one mailbox's live mail. */
export interface StalwartFolderQuery {
  folder: 'inbox' | 'archive' | 'spam' | 'trash' | 'sent' | 'drafts';
  limit: number;
  offset: number;
  /** Full-text search (JMAP Email/query `text` filter). Omitted/empty = no filter. */
  query?: string | null;
  /**
   * A CUSTOM folder's JMAP mailbox id. When set it overrides `folder` — the
   * query is scoped to this mailbox directly (used to list a user-created
   * folder, which has no `role` to resolve).
   */
  mailboxId?: string | null;
}

/** The result of a folder-scoped, paged, (optionally) searched thread listing. */
export interface StalwartFolderThreadsResult {
  threads: StalwartThread[];
  /** The total matching count when the engine reports one (JMAP calculateTotal); undefined otherwise. */
  total?: number;
}

/**
 * A JMAP Mailbox surfaced as a user-facing folder/label. `role` is non-null for
 * the system folders (inbox/sent/archive/trash/junk/drafts) and null for a
 * user-created custom folder — the distinction the folder CRUD enforces (a role
 * folder is never renamed away or destroyed).
 */
export interface StalwartMailFolder {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
  unread?: number;
}

/** The inbox unread/total counts for one mailbox (JMAP Mailbox `role: inbox`). */
export interface StalwartMailboxCounts {
  inboxUnread: number;
  inboxTotal: number;
}

/** A downloaded blob (an attachment's bytes) fetched via the engine's download endpoint. */
export interface StalwartBlobDownload {
  data: Buffer;
  contentType: string | null;
}

/** The result of uploading a blob (an attachment) to the engine's blob store. */
export interface StalwartUploadResult {
  blobId: string;
  type: string;
  size: number;
}

/** A single message's threading headers, resolved by internal/engine message id. */
export interface StalwartMessageHeaders {
  messageIdHeader: string | null;
  references: string[] | null;
}

/**
 * A request to send (or stage a draft of) an outbound message through the
 * mail engine. The lane is chosen by the service:
 *   - transactional sends route via Postmark (high-rep);
 *   - everything else via Stalwart SMTP/JMAP.
 */
export interface StalwartSendRequest {
  /** The workspace's deliverable identity (the From mailbox). */
  fromAddress: string;
  fromName?: string | null;
  toAddress: string;
  /**
   * Multiple recipients (webmail wave: comma-joined `to_address` fan-out).
   * When present + non-empty, this is authoritative and `toAddress` is just
   * its first entry (back-compat single-recipient field); when absent,
   * `toAddress` is the sole recipient.
   */
  toAddresses?: string[];
  subject: string;
  /** Plain-text body. */
  body: string;
  /** Optional HTML body; when present the engine sends multipart/alternative. */
  bodyHtml?: string | null;
  /** The thread to reply within (so the engine threads the reply). */
  inReplyToThreadId?: string | null;
  /** Additional recipients (optional; back-compat when omitted). */
  cc?: string[];
  bcc?: string[];
  /** Attachments to carry, referencing blobIds already uploaded to the engine. */
  attachments?: { blobId: string; name: string; type: string }[];
  /** The Message-ID header of the message being replied to (for In-Reply-To). */
  inReplyTo?: string | null;
  /** The References header chain (oldest first), for correct thread linking. */
  references?: string[];
  /**
   * Additional custom headers to stamp on the outbound message (Wave 7: the
   * agent-reply runtime's X-UC-Agent-Autoreply loop-protection marker). Set by
   * the service layer only — never mapped from wire input.
   */
  headers?: { name: string; value: string }[];
}

/**
 * The result of handing a message to the mail engine for delivery.
 * `accepted=false` means the engine rejected/queued-failed it (the service
 * records FAILED). On accept, the provider message + thread ids are echoed.
 */
export interface StalwartSendResult {
  accepted: boolean;
  /** The provider message id (Stalwart/Postmark message id). */
  providerMessageId: string | null;
  /** The thread the message landed in (new or the replied-to thread). */
  threadId: string | null;
  /** Which deliverability lane carried it: 'stalwart' | 'james' | 'postmark'. */
  lane: 'stalwart' | 'james' | 'postmark' | null;
  /** A human reason on rejection (logged). */
  reason?: string | null;
}

/** The JMAP VacationResponse singleton state. */
export interface StalwartVacationState {
  isEnabled: boolean;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
  fromDate: string | null;
  toDate: string | null;
}

/** A draft create/update payload in the mailbox's Drafts folder. */
export interface StalwartDraftRequest {
  fromAddress: string;
  fromName?: string | null;
  toAddress: string;
  toAddresses?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  cc?: string[];
  bcc?: string[];
  attachments?: { blobId: string; name: string; type: string }[];
  /** RFC Message-ID of the message being replied to (In-Reply-To header). */
  inReplyTo?: string | null;
  /** The References header chain (oldest first). */
  references?: string[];
}

/** One newly-arrived inbound message the watcher must classify. */
export interface InboundMessageRef {
  threadId: string;
  fromAddress: string | null;
  /** Every address on the To header (rules evaluate 'to' conditions against
   *  these — the REAL recipients, not the polled mailbox's own address).
   *  Optional for older fakes/engines; absent = header unknown. */
  toAddresses?: string[];
  subject: string | null;
  receivedAt: string; // ISO
  /**
   * True when the message carries the X-UC-Agent-Autoreply header — it was
   * auto-sent by an Email-Ops agent runtime, so the agent-reply runtime must
   * NEVER auto-reply to it (Wave 7 loop protection). Optional: absent when the
   * engine didn't/couldn't read the header (fail-open to the OTHER guards).
   */
  agentAutoreply?: boolean;
}

/**
 * The result of one inbound poll of a sovereign mailbox: the advanced cursor (ISO
 * receivedAt high-water mark to persist) + the messages newer than the prior
 * cursor. First poll (sinceIso null) BASELINES — returns the current cursor with
 * an EMPTY list (no backlog reprocessing). Degrade-clean → null.
 */
export interface InboundPollResult {
  cursor: string | null;
  newMessages: InboundMessageRef[];
}
