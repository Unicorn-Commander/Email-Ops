/**
 * The Connected Accounts cleaner-engine PORT.
 *
 * This is the federated Cleaner Engine seam. The service layer depends on this
 * abstract token and the concrete client speaks HTTP to the stateless engine.
 * The only provider tokens now live in Keycloak; the app no longer owns an
 * OAuth dance or an encrypted provider-token vault.
 */

import { EngineInboxStats } from './connected-accounts.types';

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
}
