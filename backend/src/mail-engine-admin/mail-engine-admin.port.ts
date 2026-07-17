/**
 * MailEngineAdminPort — the PROVISIONING / control-plane seam for the sovereign
 * mail engine (Apache James today; Stalwart / others pluggable).
 *
 * Where the mail-engine DATA plane (StalwartPort) handles message + thread reads
 * and outbound sends, THIS port handles ADMINISTRATION: minting and removing the
 * real engine accounts / domains / quotas / aliases that sit behind Email-Ops'
 * MailboxAccount system-of-record. It is what turns `provisionMailbox` from a
 * registry write into an ACTUAL mailbox on the mail server — i.e. the
 * "agents manage the mail server" capability that motivates the James migration.
 *
 * The concrete impl (JamesAdminClient) drives Apache James' WebAdmin REST API.
 *
 * DEGRADE-CLEAN (binding, same discipline as StalwartPort): when no admin engine
 * is configured (`isConfigured()` false), every method is a safe no-op that
 * reports `provisioned:false` WITHOUT a network call and NEVER throws.
 * MailboxAccountsService then leaves the row in its honest REGISTERED state
 * instead of failing — so Email-Ops runs unchanged when no WebAdmin endpoint is
 * wired, and "lights up" (REGISTERED → PROVISIONED) the moment one is.
 */

/** The outcome of an engine admin mutation. Never throws; carries a reason. */
export interface EngineProvisionResult {
  /** True when the object was actually minted on (or already present in) the engine. */
  provisioned: boolean;
  /** A human reason when not provisioned (logged); null on success. */
  reason: string | null;
}

/** A domain the engine serves. */
export interface EngineDomainInfo {
  domain: string;
}

/** An account (mailbox login) the engine hosts. */
export interface EngineAccountInfo {
  address: string;
}

export abstract class MailEngineAdminPort {
  /**
   * Is an admin engine (e.g. James WebAdmin) configured at all? Pure / synchronous
   * so the service can branch before any I/O. When false, every method below is a
   * degrade-clean no-op.
   */
  abstract isConfigured(): boolean;

  /** Ensure `domain` exists on the engine (idempotent). */
  abstract ensureDomain(domain: string): Promise<EngineProvisionResult>;

  /** Remove `domain` from the engine (idempotent; the caller decides when this is safe). */
  abstract removeDomain(domain: string): Promise<EngineProvisionResult>;

  /** The domains the engine serves ([] when not configured / on failure). */
  abstract listDomains(): Promise<EngineDomainInfo[]>;

  /**
   * Mint (or confirm) a real engine account for `address`: ensures the domain
   * exists, creates the login (with `password`, or a generated one when null and
   * auth is delegated to OIDC), ensures the standard mailboxes, and applies the
   * size quota (5 GiB by default; explicit null opts out of quota application).
   * Idempotent — re-running a provisioned address is a no-op that still reports
   * `provisioned:true`.
   */
  abstract ensureAccount(
    address: string,
    opts?: { password?: string | null; quotaBytes?: number | null },
  ): Promise<EngineProvisionResult>;

  /** Remove an engine account (idempotent). */
  abstract removeAccount(address: string): Promise<EngineProvisionResult>;

  /** The accounts the engine hosts ([] when not configured / on failure). */
  abstract listAccounts(): Promise<EngineAccountInfo[]>;

  /** Set a per-account size quota in bytes (null clears it). */
  abstract setQuota(address: string, quotaBytes: number | null): Promise<EngineProvisionResult>;

  /** Add an alias so mail to `source` is delivered to `destination` (idempotent). */
  abstract addAlias(source: string, destination: string): Promise<EngineProvisionResult>;

  /** Remove an alias mapping (idempotent). */
  abstract removeAlias(source: string, destination: string): Promise<EngineProvisionResult>;
}
