/**
 * MailProviderPort — the unified-inbox seam for EXTERNAL mail accounts.
 *
 * A `MailboxAccount` whose `provider` is 'gmail' or 'microsoft' is read and sent
 * through this port instead of the sovereign Stalwart engine. The concrete impl
 * (`EngineMailProvider`) resolves a per-request OAuth token from the Keycloak
 * broker and calls the cleaner-engine's /mail/* routes. The sovereign
 * ('stalwart') path stays in EmailService; this port is only consulted when a
 * mailbox is external.
 *
 * Degrade-clean, exactly like StalwartPort: an unconnected account / dormant
 * engine yields [] (reads) or accepted:false (send) — NEVER throws. This keeps
 * `/mail` honest while OAuth credentials are still being wired per deployment.
 *
 * The shapes returned are the federation wire shapes (ThreadView/MessageView)
 * WITHOUT the disposition overlay — EmailService merges the overlay so external
 * accounts get the same Inbox/Archive/Trash/Spam folders as the sovereign box.
 */

import { MailboxAccount } from '@prisma/client';
import { MailFolder, MessageView, ThreadView } from '../email/email.types';

export interface MailProviderSendRequest {
  from: string;
  to: string;
  subject: string;
  body: string;
  /** HTML alternative. Sent as the Graph/MIME HTML body when present. */
  bodyHtml?: string | null;
  /** Carried on the external lane too — a silently dropped cc/bcc is data loss. */
  cc?: string[];
  bcc?: string[];
  inReplyToThreadId?: string | null;
}

export interface MailProviderSendResult {
  accepted: boolean;
  providerMessageId: string | null;
  threadId: string | null;
  reason: string | null;
}

/**
 * Honest list result for an external mailbox.
 *
 * Gmail/Graph paginate with an opaque `pageToken` — never a numeric offset.
 * `hasMore` is true ONLY when `nextPageToken` is present. A search the provider
 * cannot honour returns empty threads with `searchSupported: false` (never the
 * unfiltered inbox).
 */
export interface MailProviderListResult {
  threads: ThreadView[];
  nextPageToken: string | null;
  hasMore: boolean;
  searchSupported: boolean;
  reason: string | null;
}

export interface MailProviderListOpts {
  folder: MailFolder;
  limit: number;
  /** Gmail-style search string (operators mapped by the provider). */
  query?: string | null;
  /**
   * Opaque provider page cursor (Gmail pageToken / Graph @odata.nextLink).
   * Preferred over numeric offset for external accounts.
   */
  pageToken?: string | null;
  /**
   * Numeric offset — NOT supported by Gmail/Graph. When offset > 0 and no
   * pageToken is supplied, the provider returns an empty page with hasMore:false
   * rather than silently re-serving page 1.
   */
  offset?: number;
}

/**
 * What to put in a provider-side draft. Identical to the send request — the
 * draft and the send it becomes MUST carry the same fields, or the human would
 * approve a draft showing recipients the send then quietly omits.
 */
export type MailProviderDraftRequest = MailProviderSendRequest;

/**
 * Result of mirroring a staged draft into the provider's own Drafts folder.
 * `created:false` is the honest degrade — the caller must not claim a mirror
 * that does not exist.
 */
export interface MailProviderDraftResult {
  created: boolean;
  draftId: string | null;
  threadId: string | null;
  webLink: string | null;
  reason: string | null;
}

export abstract class MailProviderPort {
  /** True for mailboxes this port serves (external providers: gmail / microsoft). */
  abstract handles(mailbox: Pick<MailboxAccount, 'provider'>): boolean;

  /** Live inbox threads for a folder (newest-first), with honest search + paging. */
  abstract listInbox(
    mailbox: MailboxAccount,
    opts: MailProviderListOpts,
  ): Promise<MailProviderListResult>;

  /** The messages in one thread. [] when not connected. */
  abstract listThreadMessages(mailbox: MailboxAccount, threadId: string): Promise<MessageView[]>;

  /** Send / reply through the external account. accepted:false when not connected. */
  abstract send(
    mailbox: MailboxAccount,
    req: MailProviderSendRequest,
  ): Promise<MailProviderSendResult>;

  /**
   * Mirror a staged draft into the provider's REAL Drafts folder so the human
   * reviews it in their own client (Outlook / Gmail) before approving.
   *
   * This is NOT a send and NOT an approval: the agent-inbox item stays the
   * approval choke point, and this copy exists only to be read. created:false
   * when not connected / the provider has no draft lane — never throws.
   */
  abstract createDraft(
    mailbox: MailboxAccount,
    req: MailProviderDraftRequest,
  ): Promise<MailProviderDraftResult>;

  /**
   * Delete a previously mirrored draft — reconciles the mirror once the
   * agent-inbox item is approved (the real send happened) or rejected (the
   * draft must not linger). false when not connected; never throws.
   */
  abstract deleteDraft(mailbox: MailboxAccount, draftId: string): Promise<boolean>;

  // Thread-level TRIAGE verbs — make Archive/Trash/Spam/Inbox-restore/read-state
  // REAL in the external mailbox. The disposition overlay stays the UI's source
  // of truth; these reconcile the actual Gmail/M365 box so the triage doesn't
  // undo itself on the provider side. Degrade-clean: false when not connected /
  // the engine is dormant / the provider refused — NEVER throws.

  /** Archive the whole thread in the real external mailbox. */
  abstract archiveThread(mailbox: MailboxAccount, threadId: string): Promise<boolean>;

  /** Move the whole thread to the provider's trash. */
  abstract trashThread(mailbox: MailboxAccount, threadId: string): Promise<boolean>;

  /** Report the whole thread as spam (the provider's junk folder / SPAM label). */
  abstract spamThread(mailbox: MailboxAccount, threadId: string): Promise<boolean>;

  /** Restore the whole thread to the provider's inbox (un-archive/un-trash/un-spam). */
  abstract restoreThreadToInbox(mailbox: MailboxAccount, threadId: string): Promise<boolean>;

  /** Set/clear read state on every message in the thread. */
  abstract setThreadRead(
    mailbox: MailboxAccount,
    threadId: string,
    read: boolean,
  ): Promise<boolean>;

  /**
   * Set/clear the star/flag on the thread in the real external mailbox
   * (Gmail STARRED label / Graph flag). Makes the star PERSIST instead of
   * reverting on the next refresh. false when not connected; never throws.
   */
  abstract setThreadFlagged(
    mailbox: MailboxAccount,
    threadId: string,
    flagged: boolean,
  ): Promise<boolean>;

  /**
   * Inbox unread/total for an external mailbox (Gmail label counts / Graph
   * mailFolders/inbox). null when not connected / engine dormant — the caller
   * maps null to an honest error entry, never a confident "0".
   */
  abstract getInboxCounts(
    mailbox: MailboxAccount,
  ): Promise<{ inboxUnread: number; inboxTotal: number } | null>;

  /**
   * Fetch one attachment's BYTES on demand for the reader. For external
   * providers a message id is required alongside the provider attachment id
   * (the reader carries a composite blob_id `${messageId}::${attachmentId}`).
   * null when not connected / the blob is unknown — the caller maps null to 404.
   */
  abstract downloadAttachment(
    mailbox: MailboxAccount,
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; contentType: string | null; filename: string | null } | null>;

  /**
   * The authoritative linked address for (provider, owning user) — fetched from
   * the provider, so connecting registers the real Gmail/M365 address even when
   * it differs from the user's login identity. null when not connected.
   */
  abstract resolveOwnAddress(
    provider: 'gmail' | 'microsoft',
    ucUid: string,
  ): Promise<string | null>;
}
