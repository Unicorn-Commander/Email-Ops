/**
 * The Connected Accounts cleaner-engine PORT.
 *
 * This mirrors the StalwartPort seam: the service layer depends only on this
 * abstract token, and the concrete client federates the stateless Cleaner
 * Engine over HTTP. The backend owns the tenancy and encrypted credential vault;
 * the engine receives credentials on every call and persists nothing.
 *
 * DEGRADE-CLEAN: when CLEANER_ENGINE_URL or CLEANER_ENGINE_TOKEN is unset, or
 * any transport call fails, methods return null / empty and never throw. Reads
 * that do not need credentials still work in the service layer.
 */

import { EngineInboxStats, EngineProfile } from './connected-accounts.types';

export abstract class ConnectedAccountsEnginePort {
  abstract isConfigured(): boolean;

  abstract getOAuthUrl(provider: string, redirectUri: string): Promise<string | null>;

  abstract exchangeCode(
    provider: string,
    code: string,
    redirectUri: string,
  ): Promise<Record<string, unknown> | null>;

  abstract getProfile(
    provider: string,
    credentials: Record<string, unknown>,
  ): Promise<EngineProfile | null>;

  abstract getInboxStats(
    provider: string,
    credentials: Record<string, unknown>,
  ): Promise<EngineInboxStats | null>;

  abstract analyzeInbox(
    provider: string,
    credentials: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
}
