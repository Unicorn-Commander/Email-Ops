/**
 * The monotonic status ladder for an outbound EmailMessage.
 *
 * Engagement webhooks (Part A) arrive asynchronously and CAN arrive out of
 * order (Postmark may deliver an Open before the Delivery it implies, or
 * re-deliver an old record). A later event must NEVER regress the message to an
 * earlier rung. This rank lets the webhook updater compute the post-image as
 * `max(current, incoming)` over the send/delivery progression, while terminal
 * off-ramps (BOUNCED/FAILED/REJECTED) always win once set.
 *
 * Ranking rationale:
 *   QUEUED(10) < SENT(20) < DELIVERED(30)         — the linear send progression.
 *   BOUNCED(40) / FAILED(40) / REJECTED(40)       — terminal: once a message has
 *     bounced/failed/been-rejected, no later "softer" signal (e.g. a late Open
 *     for a since-bounced address) pulls it back to DELIVERED.
 *   DRAFT(0) / PENDING_APPROVAL(5)                 — pre-send lifecycle; a webhook
 *     never targets these (a draft has no provider id), but they're ranked low so
 *     the max() math is well-defined if one ever appears.
 *
 * NOTE: this is an APPLICATION-level ordering for the webhook updater only. It is
 * deliberately NOT a DB constraint — the agent-inbox approve/reject lane and the
 * compose lane set status directly and legitimately move "down" the lifecycle
 * (e.g. a fresh DRAFT). The webhook updater is the only writer that must be
 * non-regressing, so it is the only caller of `shouldAdvanceStatus`.
 */

import { EmailMessageStatus } from '@prisma/client';

export const STATUS_RANK: Record<EmailMessageStatus, number> = {
  DRAFT: 0,
  PENDING_APPROVAL: 5,
  QUEUED: 10,
  SENT: 20,
  DELIVERED: 30,
  BOUNCED: 40,
  FAILED: 40,
  REJECTED: 40,
};

/**
 * Should a webhook advance `current` → `incoming`? True iff `incoming` is a
 * strictly higher rung (so equal/lower is a no-op — the non-regression rule).
 * `incoming === null` means the record carries no status transition (e.g. a bare
 * Open/Click is engagement-only) and is always a no-op for status.
 */
export function shouldAdvanceStatus(
  current: EmailMessageStatus,
  incoming: EmailMessageStatus | null,
): boolean {
  if (incoming == null) return false;
  return STATUS_RANK[incoming] > STATUS_RANK[current];
}
