/**
 * Compose calls from the web client are human-originated. Every other
 * provenance is treated as agent-originated so a missing or unfamiliar source
 * cannot bypass the workspace pause fence.
 */
export const HUMAN_COMPOSE_SOURCE = 'email-ops-client';

export function isAgentOrigin(
  externalSource: string | null | undefined,
  draftedBy: string | null | undefined,
): boolean {
  // An explicit draftedBy is provenance, even if the transport source is the
  // human client. Treat an empty explicit value as agent-originated too.
  if (draftedBy !== null && draftedBy !== undefined) return true;

  return externalSource?.trim().toLowerCase() !== HUMAN_COMPOSE_SOURCE;
}
