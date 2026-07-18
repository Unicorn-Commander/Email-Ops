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
