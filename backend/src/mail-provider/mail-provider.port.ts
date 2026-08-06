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
  inReplyToThreadId?: string | null;
}

export interface MailProviderSendResult {
  accepted: boolean;
  providerMessageId: string | null;
  threadId: string | null;
  reason: string | null;
}

export abstract class MailProviderPort {
  /** True for mailboxes this port serves (external providers: gmail / microsoft). */
  abstract handles(mailbox: Pick<MailboxAccount, 'provider'>): boolean;

  /** Live inbox threads for a folder (newest-first). [] when not connected. */
  abstract listInbox(
    mailbox: MailboxAccount,
    opts: { folder: MailFolder; limit: number },
  ): Promise<ThreadView[]>;

  /** The messages in one thread. [] when not connected. */
  abstract listThreadMessages(mailbox: MailboxAccount, threadId: string): Promise<MessageView[]>;

  /** Send / reply through the external account. accepted:false when not connected. */
  abstract send(
    mailbox: MailboxAccount,
    req: MailProviderSendRequest,
  ): Promise<MailProviderSendResult>;

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
   * The authoritative linked address for (provider, owning user) — fetched from
   * the provider, so connecting registers the real Gmail/M365 address even when
   * it differs from the user's login identity. null when not connected.
   */
  abstract resolveOwnAddress(
    provider: 'gmail' | 'microsoft',
    ucUid: string,
  ): Promise<string | null>;
}
