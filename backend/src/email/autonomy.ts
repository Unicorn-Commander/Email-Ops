/**
 * Autonomy-dial enforcement (pure decision logic).
 *
 * The agent registry carries a per-agent autonomy level (L0/L1/L2) + an optional
 * recipient policy. This module turns those into the ONE decision the send path
 * needs: given an agent-initiated compose, what is the EFFECTIVE mode — send now,
 * or stage a draft for human approval?
 *
 * The rule is deliberately conservative + opt-in, so wiring it into the shared
 * compose path can never make an existing flow LESS safe:
 *   - unregistered agent (null)   → honor the requested mode (legacy; no gate).
 *   - requested 'draft'           → always honored (staging is never less safe).
 *   - registered L0 / L1 + 'send' → coerced to 'draft' (a human approves the send).
 *   - registered L2 + 'send'      → allowed, UNLESS the recipient policy requires
 *                                   approval for an external recipient → 'draft'.
 *
 * Kept pure (no Nest / Prisma client deps) so it is exhaustively unit-testable
 * without a database.
 */

import { AgentAutonomyLevel } from '@prisma/client';

/** The minimal registered-agent shape the gate reads. */
export interface AutonomyAgent {
  key: string;
  autonomyLevel: AgentAutonomyLevel;
  recipientPolicy: unknown;
}

/** Parsed per-recipient-class policy (the Agent.recipientPolicy JSON). */
export interface RecipientPolicy {
  /** When true, an L2 agent still needs human approval for EXTERNAL recipients. */
  requireApprovalForExternal: boolean;
  /** Domains treated as internal (lowercased, no leading '@'). */
  internalDomains: string[];
}

const EMPTY_POLICY: RecipientPolicy = { requireApprovalForExternal: false, internalDomains: [] };

/** Tolerant parse of the JSON-on-row recipient policy (unknown shape → empty). */
export function parseRecipientPolicy(raw: unknown): RecipientPolicy {
  if (!raw || typeof raw !== 'object') return EMPTY_POLICY;
  const obj = raw as Record<string, unknown>;
  const domains = Array.isArray(obj.internalDomains)
    ? obj.internalDomains
        .filter((d): d is string => typeof d === 'string')
        .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean)
    : [];
  return { requireApprovalForExternal: obj.requireApprovalForExternal === true, internalDomains: domains };
}

/**
 * Is `toAddress` outside the policy's internal domains? An unparseable/empty
 * domain, or no internal domains defined, is treated as EXTERNAL (the safer side).
 */
export function isExternalRecipient(toAddress: string, internalDomains: string[]): boolean {
  const at = (toAddress ?? '').lastIndexOf('@');
  const domain = at >= 0 ? toAddress.slice(at + 1).trim().toLowerCase() : '';
  if (!domain) return true;
  if (internalDomains.length === 0) return true;
  return !internalDomains.includes(domain);
}

export interface ComposeModeDecision {
  mode: 'send' | 'draft';
  /** Was a requested 'send' downgraded to 'draft' by the gate? */
  coerced: boolean;
  reason: string;
}

/** Decide the effective compose mode, enforcing the autonomy dial. */
export function decideComposeMode(args: {
  requestedMode: 'send' | 'draft';
  agent: AutonomyAgent | null;
  toAddress: string;
}): ComposeModeDecision {
  const { requestedMode, agent, toAddress } = args;

  if (!agent) return { mode: requestedMode, coerced: false, reason: 'unregistered-agent' };
  if (requestedMode === 'draft') return { mode: 'draft', coerced: false, reason: 'requested-draft' };

  if (agent.autonomyLevel !== AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT) {
    // L0_DRAFT_ONLY and L1_APPROVE_TO_SEND both stage for human approval.
    return { mode: 'draft', coerced: true, reason: `${agent.autonomyLevel}-requires-approval` };
  }

  // L2: autonomous, but a recipient policy can still require approval for external mail.
  const policy = parseRecipientPolicy(agent.recipientPolicy);
  if (policy.requireApprovalForExternal && isExternalRecipient(toAddress, policy.internalDomains)) {
    return { mode: 'draft', coerced: true, reason: 'L2-external-recipient-requires-approval' };
  }
  return { mode: 'send', coerced: false, reason: 'L2-autonomous-audited' };
}
