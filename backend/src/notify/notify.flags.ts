/**
 * Notify-plane feature flags (Wave 9 — approval notifications).
 *
 * Mirrors the codebase's dormant-seam posture (common/workspace/feature-flags.ts,
 * agent-reply.flags.ts): every flag defaults to CURRENT behavior via an injectable
 * EnvGetter, so the same helper works in DI services AND unit tests without
 * mutating real process.env semantics.
 *
 * NOTE on the two dials:
 *   - The StableNotifierService is DORMANT purely on EMAIL_OPS_NOTIFY_WEBHOOK_URL
 *     (no URL → every method no-ops). Per-approval pings ride that dial.
 *   - The hourly STALE-APPROVAL ESCALATION SWEEP has an ADDITIONAL master switch,
 *     EMAIL_OPS_NOTIFY_ENABLED (this file): the periodic proactive escalation is a
 *     louder behavior you turn on deliberately, independent of the real-time pings.
 *     Default OFF == today's behavior (no sweep) — the dormant-seam rule.
 */

type EnvGetter = (key: string) => string | undefined;

const defaultGetter: EnvGetter = (k) => process.env[k];

function truthy(value: string | undefined | null, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const s = value.toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * The stale-approval escalation sweep master switch. Default OFF: the hourly cron
 * returns immediately (no cross-tenant scan, no notify). Flip to true (AND set the
 * notifier's webhook env) to enable the hourly "N approvals waiting" escalation.
 */
export function notifySweepEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('EMAIL_OPS_NOTIFY_ENABLED'), false);
}
