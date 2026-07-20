/**
 * Autonomy-dial enforcement (pure decision logic).
 *
 * The agent registry carries a per-agent autonomy level (L0/L1/L2) + an optional
 * recipient policy. This module turns those into the ONE decision the send path
 * needs: given an agent-initiated compose, what is the EFFECTIVE mode — send now,
 * or stage a draft for human approval?
 *
 * The rule is deliberately conservative, so wiring it into the shared compose
 * path can never make an existing flow LESS safe:
 *   - unregistered + TRUSTED source + 'send' → honored (the human web client and
 *                                   known first-party federation partners).
 *   - unregistered + UNTRUSTED source + 'send' → coerced to 'draft' (FAIL-SAFE:
 *                                   a prompt-injected or spoofed automation that
 *                                   claims an unknown provenance can NOT send
 *                                   autonomously — it stages for human approval).
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

// ─────────────────────────────────────────────────────────────────────────────
// Wave 7 — the agent-send autonomy MATRIX ("first contact needs a human;
// ongoing conversation flows"). Pure additions only: decideComposeMode above
// keeps its exact signature/behavior for every existing call site; the matrix
// lives in decideAgentComposeMode, which composes with it.
// ─────────────────────────────────────────────────────────────────────────────

/** One machine+human reason a requested send was held for approval. */
export interface PolicyReason {
  code: string;
  message: string;
}

/**
 * The class of the SENDING mailbox:
 *   - 'agent'   — Class B: an active registered agent is linked to it (its send
 *                 identity); the autonomy matrix applies.
 *   - 'user'    — Class A: a sovereign human/shared box; agent-initiated compose
 *                 ALWAYS stages for approval regardless of autonomy level.
 *   - 'unknown' — lookup failed / no mailbox → treated as Class A (fail-safe).
 */
export type MailboxClass = 'user' | 'agent' | 'unknown';

/** The precomputed, dependency-free inputs the matrix reads (built by the service). */
export interface AgentComposeContext {
  mailboxClass: MailboxClass;
  /** Workspace MailDomain rows ∪ the agent recipientPolicy.internalDomains (lowercased, no '@'). */
  internalDomains: string[];
  /** EVERY recipient (to + cc + bcc), normalized to bare lowercased addresses. */
  recipients: string[];
  /**
   * Is this an in-thread reply where the thread verifiably contains an INBOUND
   * message from at least one external recipient (the agent is not cold-initiating)?
   */
  isInThreadReplyToInbound: boolean;
  attachmentCount: number;
  /** Trusted-correspondent addresses (lowercased) among `recipients`. */
  trustedAddresses: Set<string>;
  /** AGENT_AUTONOMOUS_SEND_ENABLED !== 'false' (the global switch). */
  autonomousSendEnabled: boolean;
}

/** The matrix decision: the base decision + the full machine+human reason list. */
export interface AgentComposeDecision extends ComposeModeDecision {
  reasons: PolicyReason[];
}

/** ROUTINE bound: an L2 external auto-send may reach at most this many external recipients. */
export const MAX_ROUTINE_EXTERNAL_RECIPIENTS = 5;

/** How many per-address first-contact reasons to spell out before summarizing. */
const MAX_FIRST_CONTACT_REASONS = 5;

/**
 * Normalize one recipient entry ("Name <a@b>" or a bare address) to a bare
 * lowercased address for trust/externality comparison. Never drops an entry —
 * an unparseable value stays as its trimmed lowercase self (and classifies as
 * EXTERNAL downstream, the safer side).
 */
export function normalizeAddress(raw: string): string {
  const trimmed = (raw ?? '').trim();
  const angled = trimmed.match(/<([^<>]+)>\s*$/);
  return (angled ? angled[1] : trimmed).trim().toLowerCase();
}

/** Split a (normalized) recipient list into internal vs external per the domain list. */
export function splitRecipients(
  recipients: string[],
  internalDomains: string[],
): { internal: string[]; external: string[] } {
  const internal: string[] = [];
  const external: string[] = [];
  for (const addr of recipients) {
    (isExternalRecipient(addr, internalDomains) ? external : internal).push(addr);
  }
  return { internal, external };
}

/**
 * Decide the effective compose mode for an AGENT-initiated compose, enforcing
 * the Wave-7 matrix. Pure — every input is precomputed by the caller.
 *
 * Without `agentContext` this is EXACTLY decideComposeMode (reasons derived from
 * its single reason), so wiring it in changes nothing for paths that don't build
 * a context (the human/trusted-source lane, requested drafts, unregistered
 * sources). With a context and a REGISTERED agent requesting 'send':
 *
 *   Class A ('user'/'unknown') mailbox → draft, always (any autonomy level).
 *   Class B ('agent') mailbox:
 *     L0_DRAFT_ONLY       → draft (everything).
 *     L1_APPROVE_TO_SEND  → all-internal recipients: SEND; ANY external → draft.
 *     L2_AUTONOMOUS_AUDIT → all-internal: SEND; external: SEND only when ROUTINE:
 *       in-thread reply to a real inbound from an external recipient (not cold),
 *       EVERY external recipient trusted, zero attachments, ≤5 external
 *       recipients, and the global switch enabled. Any miss → draft, with EVERY
 *       failed condition spelled out in `reasons`.
 *     (An agent recipientPolicy.requireApprovalForExternal=true still binds —
 *      the per-agent dial can only make sends MORE gated, never less.)
 */
export function decideAgentComposeMode(args: {
  requestedMode: 'send' | 'draft';
  agent: AutonomyAgent | null;
  toAddress: string;
  trustedUnregisteredSend?: boolean;
  agentContext?: AgentComposeContext | null;
}): AgentComposeDecision {
  const { requestedMode, agent, toAddress, trustedUnregisteredSend, agentContext } = args;

  // No context (or no registered agent, or a requested draft) → the base gate,
  // byte-identical, with its single reason surfaced as the reasons list.
  if (!agentContext || !agent || requestedMode === 'draft') {
    const base = decideComposeMode({ requestedMode, agent, toAddress, trustedUnregisteredSend });
    return {
      ...base,
      reasons: base.coerced
        ? [{ code: baseReasonCode(base.reason), message: baseReasonMessage(base.reason) }]
        : [],
    };
  }

  const hold = (reasons: PolicyReason[], reason: string): AgentComposeDecision => ({
    mode: 'draft',
    coerced: true,
    reason,
    reasons,
  });

  // Class A (or unresolvable) sending mailbox: a human's (or unknown) identity —
  // an agent-initiated send ALWAYS stages for approval, regardless of the dial.
  if (agentContext.mailboxClass !== 'agent') {
    return hold(
      [
        {
          code: 'class-a-mailbox',
          message:
            'This is a human/shared mailbox — agent-initiated mail from it always needs a human approval.',
        },
      ],
      'class-a-mailbox-requires-approval',
    );
  }

  if (agent.autonomyLevel === AgentAutonomyLevel.L0_DRAFT_ONLY) {
    return hold(
      [{ code: 'l0-draft-only', message: 'This agent is draft-only (L0) — every send needs a human approval.' }],
      'L0_DRAFT_ONLY-requires-approval',
    );
  }

  const { external } = splitRecipients(agentContext.recipients, agentContext.internalDomains);

  if (agent.autonomyLevel === AgentAutonomyLevel.L1_APPROVE_TO_SEND) {
    // Wave 7 semantics: L1 = internal-autonomous. All-internal sends flow;
    // ANY external recipient stages for approval.
    if (external.length === 0) {
      return { mode: 'send', coerced: false, reason: 'L1-internal-autonomous', reasons: [] };
    }
    return hold(
      [
        {
          code: 'l1-external',
          message: `This agent (L1) sends internally on its own; external recipients (${summarize(external)}) need a human approval.`,
        },
      ],
      'L1-external-requires-approval',
    );
  }

  // L2_AUTONOMOUS_AUDIT.
  if (external.length === 0) {
    return { mode: 'send', coerced: false, reason: 'L2-internal-autonomous', reasons: [] };
  }

  // The per-agent dial stays binding: a policy that requires approval for
  // external mail can only make things MORE gated than the routine matrix.
  const policy = parseRecipientPolicy(agent.recipientPolicy);
  if (policy.requireApprovalForExternal) {
    return hold(
      [
        {
          code: 'l2-external-policy',
          message: "This agent's recipient policy requires human approval for all external mail.",
        },
      ],
      'L2-external-recipient-requires-approval',
    );
  }

  // ROUTINE check — collect EVERY failed condition, not just the first.
  const reasons: PolicyReason[] = [];
  if (!agentContext.autonomousSendEnabled) {
    reasons.push({
      code: 'autonomous-send-disabled',
      message: 'Autonomous agent sends are globally disabled (AGENT_AUTONOMOUS_SEND_ENABLED=false).',
    });
  }
  if (!agentContext.isInThreadReplyToInbound) {
    reasons.push({
      code: 'cold-outbound',
      message:
        'Not a reply to an inbound message from these recipients — cold outreach always needs a human approval.',
    });
  }
  if (agentContext.attachmentCount > 0) {
    reasons.push({
      code: 'attachment',
      message: `Carries ${agentContext.attachmentCount} attachment(s) — attachments always need a human approval.`,
    });
  }
  if (external.length > MAX_ROUTINE_EXTERNAL_RECIPIENTS) {
    reasons.push({
      code: 'bulk-external',
      message: `${external.length} external recipients (max ${MAX_ROUTINE_EXTERNAL_RECIPIENTS} for an autonomous send).`,
    });
  }
  const untrusted = external.filter((addr) => !agentContext.trustedAddresses.has(addr));
  for (const addr of untrusted.slice(0, MAX_FIRST_CONTACT_REASONS)) {
    reasons.push({
      code: 'first-contact',
      message: `First contact with ${addr} — approve once to trust this correspondent.`,
    });
  }
  if (untrusted.length > MAX_FIRST_CONTACT_REASONS) {
    reasons.push({
      code: 'first-contact',
      message: `…and ${untrusted.length - MAX_FIRST_CONTACT_REASONS} more first-contact recipient(s).`,
    });
  }

  if (reasons.length > 0) {
    return hold(reasons, 'L2-external-not-routine');
  }
  return { mode: 'send', coerced: false, reason: 'L2-routine-external-autonomous', reasons: [] };
}

/** Map a base decideComposeMode reason string to a stable machine code. */
function baseReasonCode(reason: string): string {
  if (reason === 'unregistered-untrusted-source-fail-safe') return 'untrusted-source';
  if (reason.endsWith('-requires-approval')) return 'autonomy-dial';
  return reason;
}

/** A human line for the base gate's coercions. */
function baseReasonMessage(reason: string): string {
  if (reason === 'unregistered-untrusted-source-fail-safe') {
    return 'Unregistered, untrusted source — the send was staged for a human approval.';
  }
  return 'The agent autonomy dial requires a human approval for this send.';
}

/** "a@b, c@d" bounded to 3 entries for a human-readable reason line. */
function summarize(addresses: string[]): string {
  const head = addresses.slice(0, 3).join(', ');
  return addresses.length > 3 ? `${head}, +${addresses.length - 3} more` : head;
}

/** Decide the effective compose mode, enforcing the autonomy dial. */
export function decideComposeMode(args: {
  requestedMode: 'send' | 'draft';
  agent: AutonomyAgent | null;
  toAddress: string;
  /**
   * Is the (unregistered) provenance a TRUSTED first-party source — the human web
   * client or a known federation partner? Only consulted when `agent` is null.
   * false (the default for any unknown/attacker-controlled source) fail-safes a
   * requested 'send' to a staged 'draft'. Ignored for registered agents.
   */
  trustedUnregisteredSend?: boolean;
}): ComposeModeDecision {
  const { requestedMode, agent, toAddress, trustedUnregisteredSend = false } = args;

  if (!agent) {
    // Unregistered provenance. Draft requests always stage. A 'send' is honored
    // ONLY from a trusted first-party source; an unknown source is fail-safed to
    // a draft so prompt-injection / a spoofed external_source cannot auto-send.
    if (requestedMode === 'draft') return { mode: 'draft', coerced: false, reason: 'requested-draft' };
    if (trustedUnregisteredSend) {
      return { mode: 'send', coerced: false, reason: 'unregistered-trusted-source' };
    }
    return { mode: 'draft', coerced: true, reason: 'unregistered-untrusted-source-fail-safe' };
  }
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
