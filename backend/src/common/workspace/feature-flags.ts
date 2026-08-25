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
 * ⚠️ **DEFAULTS ON (changed 2026-08-11). Absent means SAFE.**
 *
 * When ON: workspace routes 403 without an active Membership, and the
 * membership-derived workspace drives the RLS GUC.
 *
 * When explicitly OFF: the membership gate is a NO-OP — `resolveAndAuthorize`
 * skips the membership check entirely and `resolveWithRole` returns **OWNER for
 * every user**, so any caller is an owner of any workspace id they name. That is
 * a fine dev default and a catastrophic production one. It used to default OFF,
 * which meant a per-org customer install that merely FORGOT
 * `EMAIL_OPS_TENANCY_ENABLED` silently handed every user owner rights — a
 * missing variable should never be the unsafe choice.
 *
 * `main.ts` additionally refuses to boot when NODE_ENV=production and this is
 * off; that guard only fires when NODE_ENV is actually set, which is exactly the
 * other thing a hand-rolled install forgets. Hence: fail safe here too.
 *
 * The rollout this flag protected is COMPLETE — both rings set it true
 * explicitly — so flipping the default changes no deployed behavior.
 */
export function tenancyEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('EMAIL_OPS_TENANCY_ENABLED'), true);
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

/**
 * Whether the inbound watcher ALSO polls external (Gmail/M365) mailboxes, not
 * just sovereign James ones. Separate + default-OFF so shipping external
 * inbound automation deploys inert on a ring where the watcher is already on —
 * it starts touching real personal mail only when deliberately enabled.
 */
export function inboundWatcherExternalEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('INBOUND_WATCHER_EXTERNAL_ENABLED'), false);
}
