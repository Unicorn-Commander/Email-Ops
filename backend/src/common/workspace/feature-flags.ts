/**
 * Feature flags for Email-Ops.
 *
 * Every flag defaults to CURRENT behavior (SUITE-IDENTITY quality bar). The
 * helpers default-read process.env (which @nestjs/config populates from .env),
 * so the same helpers work in DI services and in the non-DI MCP tool layer.
 */

type EnvGetter = (key: string) => string | undefined;

const defaultGetter: EnvGetter = (k) => process.env[k];

function truthy(value: string | undefined | null, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const s = value.toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * Suite tenancy master switch (SUITE-IDENTITY).
 *
 * Default OFF == today's behavior: workspace routes do NOT require a
 * Membership row, the membership gate is a no-op, and rows resolve to
 * DEFAULT_WORKSPACE_ID. RLS exists in the DB but is inert because the runtime
 * still connects as the table owner.
 *
 * When ON (a later rollout phase, alongside flipping the runtime DATABASE_URL
 * to the NOBYPASSRLS email_ops_app role): workspace routes 403 without an
 * active Membership, and the membership-derived workspace drives the RLS GUC.
 */
export function tenancyEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('EMAIL_OPS_TENANCY_ENABLED'), false);
}

/**
 * Inbound provider-webhook master switch (Phase 2, Part A).
 *
 * Default OFF == today's behavior: the POST /webhooks/postmark route exists but
 * is NEVER open — it returns 503 (Service Unavailable) so a forged or premature
 * call can do nothing, and no engagement capture happens. Flip to true (AND set
 * POSTMARK_WEBHOOK_SECRET) to make the receiver live: it then authenticates the
 * shared secret, maps Postmark records to engagement events, and advances the
 * owning message's status.
 *
 * The flag and the secret are BOTH required for the route to do anything: the
 * guard 503s when EITHER is missing. This is the brief's "NEVER open by default"
 * posture — a deploy that hasn't been deliberately turned on is inert.
 */
export function webhooksEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('EMAIL_WEBHOOKS_ENABLED'), false);
}

/**
 * Inbound watcher master switch (Wave 2 — the agent-email fabric's inbound half).
 *
 * Default OFF == today's behavior: no polling of the sovereign James mailboxes,
 * MailTriageService.classifyInbound has no caller, and agent mailboxes receiving
 * mail do nothing. Flip to true to start the per-mailbox JMAP delta poll that
 * classifies newly-arrived mail (sender-policy + SpamPort → disposition) and
 * routes agent-mailbox arrivals to the reply seam. Off by default so the watcher
 * deploys DORMANT (the dormant-seam posture) and is enabled + verified deliberately.
 */
export function inboundWatcherEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('INBOUND_WATCHER_ENABLED'), false);
}
