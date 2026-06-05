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
  EngineBackupManifest,
  EngineInboxStats,
  EngineListMessagesResult,
  EngineMessageSummary,
} from './connected-accounts.types';

export abstract class ConnectedAccountsEnginePort {
  abstract isConfigured(): boolean;

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

  abstract backupCreate(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    query: string,
    path: string,
  ): Promise<EngineBackupManifest | null>;

  abstract backupVerify(path: string): Promise<Record<string, unknown> | null>;
}
