/**
 * Shared agent-display helpers.
 *
 * The agent provenance `key` is a snake/kebab slug owned by the API wire shape
 * (AgentView.key, AgentInboxItemView.drafted_by). Both headline cockpit surfaces
 * — the approval queue and the Agents view — render it humanized, so the one
 * rule lives here (mirroring lib/workspace.ts: one rule, one source) rather than
 * being re-derived per page.
 */

/** Humanize an agent provenance slug ('customer-ops' → 'Customer-Ops'). */
export function agentLabel(key: string | null): string {
  if (!key) return 'Unknown agent';
  return key
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join('-');
}
