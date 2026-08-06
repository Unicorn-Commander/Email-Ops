/**
 * The Stalwart mail-engine PORT.
 *
 * An abstract class used as a DI token + interface. The Email-Ops service layer
 * depends ONLY on this port, never on the concrete client — the same
 * federate-the-engine seam the suite uses everywhere (ContactOpsPort /
 * AccountingOpsPort / EmailOpsPort on the cockpit side). It gives:
 *
 *   1. The mail engine (Stalwart IMAP/JMAP + the Postmark transactional lane) is
 *      MOCKABLE in tests via a fake StalwartPort — Email-Ops' SoR + agent-inbox
 *      logic is proven without a live mail server.
 *   2. The transport (JMAP/IMAP/SMTP today; a different engine later) is
 *      swappable without touching the message/thread/agent-inbox logic.
 *
 * DEGRADE-CLEAN (binding, brief): when the STALWART_* config is unset,
 * `isConfigured()` is false. READS return [] / null and SENDS return a clean
 * `accepted:false` (lane=null) — Email-Ops never throws because the mail engine
 * isn't wired (verification, or any node where Stalwart isn't reachable). The
 * SoR write still happens (the message row + agent-inbox row are recorded); only
 * the engine hand-off degrades, so a draft can always be staged and a send is
 * recorded as FAILED rather than 500-ing. The webmail-wave additions below are
 * held to the SAME contract: any method may return an empty/null/false
 * degrade-clean result but must NEVER throw.
 */

import {
  StalwartBlobDownload,
  StalwartFolderQuery,
  StalwartFolderThreadsResult,
  StalwartMailFolder,
  StalwartMailboxCounts,
  StalwartMessage,
  StalwartMessageDetail,
  StalwartMessageHeaders,
  StalwartSendRequest,
  StalwartSendResult,
  StalwartDraftRequest,
  StalwartVacationState,
  StalwartThread,
  StalwartUploadResult,
  InboundPollResult,
} from './stalwart.types';

export abstract class StalwartPort {
  /**
   * Is a Stalwart mail engine configured at all (STALWART_JMAP_URL or
   * STALWART_IMAP_HOST set)? When false, reads return empty and sends record
   * FAILED without an engine call. Pure/synchronous so the service can branch
   * before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * List mailbox THREADS that involve `address` (the contact's deliverable
   * address) in the given mailbox. Read-only. Returns [] when not configured /
   * unknown / the call fails (degrade-clean).
   */
  abstract listThreads(mailbox: string, address: string): Promise<StalwartThread[]>;

  /**
   * List the MESSAGES in one thread (bodies as previews only). Read-only.
   * Returns [] when not configured / unknown / the call fails.
   */
  abstract listMessages(mailbox: string, threadId: string): Promise<StalwartMessage[]>;

  /**
   * Live, folder-scoped, paged, (optionally) full-text-searched thread listing
   * (the human email client's inbox list) — the webmail-wave search+paging
   * surface. Returns `{ threads: [] }` when not configured / the folder can't
   * be resolved / the call fails (degrade-clean, never throws).
   */
  abstract listFolderThreads(
    mailbox: string,
    query: StalwartFolderQuery,
  ): Promise<StalwartFolderThreadsResult>;

  /**
   * The FULL detail of every message in a thread (bodies, cc, threading
   * headers, read state, attachments) — the thread-detail enrichment. Returns
   * [] when not configured / unknown / the call fails.
   */
  abstract getThreadDetail(mailbox: string, threadId: string): Promise<StalwartMessageDetail[]>;

  /**
   * Set (read=true) or clear (read=false) the read state on every message in a
   * thread. Returns true on success, false when not configured / unknown / the
   * call fails (degrade-clean; never throws).
   */
  abstract setThreadRead(mailbox: string, threadId: string, read: boolean): Promise<boolean>;

  /**
   * Set/clear message keywords across every message in a thread. `seen` maps to
   * JMAP `$seen` / IMAP \Seen; `flagged` maps to `$flagged` / IMAP \Flagged.
   */
  abstract setThreadFlags(
    mailbox: string,
    threadId: string,
    flags: { seen?: boolean; flagged?: boolean },
  ): Promise<boolean>;

  /**
   * Move every message in a thread into the folder for `folder`
   * (archive/trash/spam→junk/inbox) under the mailbox's own account — a real
   * JMAP `Email/set` of `mailboxIds`, so the move is reflected everywhere the
   * mailbox is read (other clients, other devices), not just in our overlay.
   * Returns true on success, false when not configured / the thread is unknown
   * to this mailbox / the call fails (degrade-clean; never throws).
   */
  abstract moveThreadToFolder(
    mailbox: string,
    threadId: string,
    folder: StalwartFolderQuery['folder'],
  ): Promise<boolean>;

  /**
   * Move every message in a thread into an ARBITRARY target folder by its JMAP
   * mailbox id (a custom folder) — the move-to-folder verb for user folders,
   * distinct from the role-based moveThreadToFolder. Validates the target is a
   * real mailbox in this account first (never moves into an unknown/foreign id).
   * Returns true on success, false when not configured / the target is unknown /
   * the thread is unknown / the call fails (degrade-clean; never throws).
   */
  abstract moveThreadToMailbox(
    mailbox: string,
    threadId: string,
    targetMailboxId: string,
  ): Promise<boolean>;

  /** Permanently delete every message currently in Trash or Spam/Junk. */
  abstract emptyFolder(mailbox: string, folder: 'trash' | 'spam'): Promise<number | null>;

  /** Create a draft in the mailbox's Drafts folder. */
  abstract saveDraft(mailbox: string, draft: StalwartDraftRequest): Promise<{ id: string } | null>;

  /** Replace an existing draft with a new copy. */
  abstract updateDraft(
    mailbox: string,
    draftId: string,
    draft: StalwartDraftRequest,
  ): Promise<{ id: string } | null>;

  /** Delete one draft copy from the Drafts folder. */
  abstract deleteDraft(mailbox: string, draftId: string): Promise<boolean>;

  /** Read the mailbox's VacationResponse singleton state. */
  abstract getVacation(mailbox: string): Promise<StalwartVacationState | null>;

  /** Update the mailbox's VacationResponse singleton state. */
  abstract setVacation(mailbox: string, state: StalwartVacationState): Promise<boolean>;

  /**
   * The Inbox unread/total counts for one mailbox. Returns null when not
   * configured / unknown / the call fails — the caller renders that as a
   * zeroed, `error:true` entry rather than omitting the mailbox.
   */
  abstract getMailboxCounts(mailbox: string): Promise<StalwartMailboxCounts | null>;

  /**
   * Download one blob (an attachment's bytes) from the engine's blob store.
   * Returns null when not configured / unknown / the call fails.
   */
  abstract downloadBlob(mailbox: string, blobId: string): Promise<StalwartBlobDownload | null>;

  /**
   * Resolve one message's real threading headers (Message-ID + References) by
   * its engine message id — used to build a correct In-Reply-To/References
   * chain when the caller only has an internal message id (e.g. from the
   * thread-detail API), not an RFC Message-ID. Returns null when not
   * configured / unknown / the call fails (degrade-clean; the composer then
   * sends WITHOUT proper threading headers rather than failing outright).
   */
  abstract getMessageHeaders(mailbox: string, messageId: string): Promise<StalwartMessageHeaders | null>;

  /**
   * Upload a blob (an attachment) to the engine's blob store, scoped to the
   * mailbox's own account. Returns null when not configured / the call fails.
   */
  abstract uploadBlob(
    mailbox: string,
    file: Buffer,
    type: string,
    filename: string,
  ): Promise<StalwartUploadResult | null>;

  /**
   * Hand an outbound message to the mail engine for delivery (the SEND lane).
   * Transactional sends route via Postmark; the rest via Stalwart SMTP/JMAP.
   * `request` may now carry cc/bcc/attachments/inReplyTo/references (all
   * optional, back-compat) — an implementation that can't carry one of those
   * (e.g. attachments over Postmark) is allowed to route around it internally
   * (see JamesClient) rather than dropping it silently. Returns
   * `accepted:false` (lane=null) when not configured or on a transport
   * failure — never throws.
   */
  abstract send(
    mailbox: string,
    request: StalwartSendRequest,
    transactional: boolean,
  ): Promise<StalwartSendResult>;

  /**
   * List every folder (JMAP Mailbox) under the mailbox's own account — system
   * role folders AND user-created custom folders — for the folder rail /
   * move-to menu. Returns [] when not configured / the call fails.
   */
  abstract listFolders(mailbox: string): Promise<StalwartMailFolder[]>;

  /**
   * Create a user folder (a `role: null` Mailbox) named `name`, optionally
   * nested under `parentId`. Returns the created folder's id, or null when not
   * configured / the create fails (degrade-clean; never throws).
   */
  abstract createFolder(mailbox: string, name: string, parentId?: string | null): Promise<{ id: string } | null>;

  /**
   * Rename a folder. Returns true iff the engine reports the id updated; false
   * when not configured / the id is unknown / the call fails.
   */
  abstract renameFolder(mailbox: string, folderId: string, name: string): Promise<boolean>;

  /**
   * Destroy a USER folder. REFUSES (returns false, issues no destroy) when the
   * target has a non-null role — a system folder (Inbox/Sent/Archive/Trash/
   * Junk/Drafts) is never deletable. False also when not configured / unknown /
   * the call fails.
   */
  abstract deleteFolder(mailbox: string, folderId: string): Promise<boolean>;

  /**
   * Poll a sovereign mailbox's INBOX for messages that arrived after `sinceIso`
   * (the persisted high-water mark). First poll (sinceIso null) baselines: returns
   * the current cursor + an EMPTY list (never reprocesses the backlog). The inbound
   * watcher classifies each returned message + advances the stored cursor.
   * Degrade-clean → null (not configured / thread unknown / failed call).
   */
  abstract pollInbound(mailbox: string, sinceIso: string | null): Promise<InboundPollResult | null>;
}
