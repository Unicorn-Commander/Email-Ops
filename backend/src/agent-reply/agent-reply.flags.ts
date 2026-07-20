/**
 * Agent-reply runtime feature flag.
 *
 * Module-local (agent-reply owns its own dial) but follows the EXACT
 * common/workspace/feature-flags.ts pattern: default-read process.env via an
 * injectable EnvGetter so the same helper works in DI services and unit tests,
 * and DEFAULT OFF == current behavior (the dormant-seam posture — a deploy that
 * hasn't been deliberately turned on is inert).
 *
 * When OFF (unset/false): the inbound watcher's AGENT-mailbox hand-off still
 * logs the reply-routing seam, but no thread context is read, no LLM is called,
 * and nothing is staged. Flip to true to make an AGENT mailbox receiving mail
 * draft a reply into the agent-inbox approval queue (NEVER auto-send — every
 * draft awaits a human approve()).
 */

type EnvGetter = (key: string) => string | undefined;

const defaultGetter: EnvGetter = (k) => process.env[k];

function truthy(value: string | undefined | null, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const s = value.toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

export function agentReplyRuntimeEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('AGENT_REPLY_RUNTIME_ENABLED'), false);
}

/** Default per-mailbox runtime-draft ceiling (composes/day) when env is unset. */
export const DEFAULT_AGENT_DRAFTS_PER_MAILBOX_PER_DAY = 20;

/**
 * The spam-blast guard: at most this many runtime composes per AGENT MAILBOX per
 * rolling 24h. Over it, the runtime skips ENTIRELY (no thread read, no LLM cost,
 * no draft). Distinct from the per-THREAD auto-send cap (loop guard d).
 * EMAIL_OPS_AGENT_DRAFTS_PER_MAILBOX_PER_DAY overrides; a non-positive/garbage
 * value falls back to the default (never disables the guard by accident).
 */
export function agentDraftsPerMailboxPerDay(getEnv: EnvGetter = defaultGetter): number {
  const raw = getEnv('EMAIL_OPS_AGENT_DRAFTS_PER_MAILBOX_PER_DAY');
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AGENT_DRAFTS_PER_MAILBOX_PER_DAY;
}
