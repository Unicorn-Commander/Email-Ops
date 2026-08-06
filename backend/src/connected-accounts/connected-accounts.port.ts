/**
 * The Connected Accounts cleaner-engine PORT.
 *
 * This is the federated Cleaner Engine seam. The service layer depends on this
 * abstract token and the concrete client speaks HTTP to the stateless engine.
 * The only provider tokens now live in Keycloak; the app no longer owns an
 * OAuth dance or an encrypted provider-token vault.
 */

import {
  CleanupExecutionBackupRef,
  CleanupExecutionResult,
  CleanupPlanResult,
  EngineArchiveRef,
  EngineArchiveRestoreResult,
  EngineArchiveVerifyResult,
  EngineBackupManifest,
  EngineAccountProfile,
  EngineInboxStats,
  EngineListMessagesResult,
  EngineMailFolder,
  EngineMailSendResult,
  EngineMailThreadActionResult,
  EngineMailThreadResult,
  EngineMailThreadsResult,
  EngineMessageSummary,
} from './connected-accounts.types';

export abstract class ConnectedAccountsEnginePort {
  abstract isConfigured(): boolean;

  abstract chat(message: string, context?: Record<string, unknown>): Promise<string | null>;

  /**
   * Open a streaming chat turn against the engine. Returns the raw `text/event-stream`
   * Response (SSE `token` / `actions` / `done` frames) so the caller can proxy it, or
   * null when the engine is dormant/unreachable. No client-side timeout — the caller
   * owns the stream lifetime.
   */
  abstract chatStream(
    message: string,
    context?: Record<string, unknown>,
  ): Promise<Response | null>;

  abstract getInboxStats(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
  ): Promise<EngineInboxStats | null>;

  abstract analyzeInbox(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;

  abstract listMessages(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    query?: string,
    maxResults?: number,
    pageToken?: string | null,
  ): Promise<EngineListMessagesResult | null>;

  abstract getMessage(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageId: string,
    format?: 'metadata' | 'full' | 'minimal',
  ): Promise<EngineMessageSummary | null>;

  abstract batchTrash(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
  ): Promise<{ count: number } | null>;

  abstract batchDelete(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
  ): Promise<{ count: number } | null>;

  abstract batchArchive(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
    label?: string | null,
  ): Promise<{ count: number } | null>;

  abstract archiveCreate(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
    garage: { bucket: string; key_prefix: string },
    options?: { query?: string; workspaceId?: string; expiresAt?: string | null },
  ): Promise<EngineArchiveRef | null>;

  abstract archiveVerify(bucket: string, key: string): Promise<EngineArchiveVerifyResult | null>;

  abstract archiveRestore(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    bucket: string,
    key: string,
  ): Promise<EngineArchiveRestoreResult | null>;

  abstract backupCreate(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    query: string,
    path: string,
  ): Promise<EngineBackupManifest | null>;

  abstract backupVerify(path: string): Promise<Record<string, unknown> | null>;

  // ── Unified-inbox verbs (read inbox threads, read a thread, send/reply) ──

  /** The authenticated account's own profile (the authoritative linked address). */
  abstract getAccountProfile(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
  ): Promise<EngineAccountProfile | null>;

  abstract listMailThreads(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    folder: EngineMailFolder,
    limit?: number,
  ): Promise<EngineMailThreadsResult | null>;

  abstract getMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadResult | null>;

  // Thread-level triage verbs — make Archive/Trash/Spam/Inbox-restore/read REAL
  // in the external mailbox (the disposition overlay stays the UI's source of
  // truth).

  abstract archiveMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null>;

  abstract trashMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null>;

  abstract spamMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null>;

  abstract restoreMailThreadToInbox(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null>;

  abstract setMailThreadRead(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
    read: boolean,
  ): Promise<EngineMailThreadActionResult | null>;

  abstract sendMail(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    message: {
      from: string;
      to: string;
      subject: string;
      body: string;
      inReplyToThreadId?: string | null;
    },
  ): Promise<EngineMailSendResult | null>;
}
