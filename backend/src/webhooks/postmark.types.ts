/**
 * Postmark inbound webhook payload shapes + the record→engagement mapping.
 *
 * Postmark posts ONE JSON object per event to the configured webhook URL, with a
 * `RecordType` discriminator. Email-Ops handles the delivery/engagement record
 * types and maps each to:
 *   - a normalized suite engagement kind (opened|clicked|bounced|unsubscribed),
 *     or null when the record is a pure delivery signal, and
 *   - an EmailMessageStatus transition (or null when engagement-only), and
 *   - a stable provider dedupe key (the idempotency anchor).
 *
 * The mapping is a PURE function (no I/O) so every record-type → (kind, status)
 * row is unit-tested directly. The receiver (controller) does the auth + calls
 * EmailService.recordEngagementEvent with the normalized result.
 *
 * Field names follow Postmark's documented webhook payloads (PascalCase). We are
 * tolerant: a missing optional field degrades to null rather than throwing, so a
 * minor Postmark payload variation never 500s the receiver.
 */

import { EmailEngagementKind, EmailMessageStatus } from '@prisma/client';

/** The Postmark record types Email-Ops handles. */
export type PostmarkRecordType =
  | 'Delivery'
  | 'Open'
  | 'Click'
  | 'Bounce'
  | 'SpamComplaint'
  | 'SubscriptionChange';

/**
 * The minimal shape we read off a Postmark webhook body. Postmark sends many
 * more fields; we keep the union loose (index signature) and read the handful
 * that matter, so we never reject a payload for carrying extra keys.
 */
export interface PostmarkWebhookBody {
  RecordType?: string;
  /** The Postmark message id that ties the event back to the send. */
  MessageID?: string;
  /** Postmark's per-record unique id (when present — Bounce/SpamComplaint have
   *  a numeric `ID`; engagement records are deduped by a synthesized key). */
  ID?: string | number;
  /** Various provider timestamps depending on record type. */
  DeliveredAt?: string;
  ReceivedAt?: string;
  BouncedAt?: string;
  ChangedAt?: string;
  /** Bounce specifics. */
  Type?: string; // bounce type (HardBounce, SoftBounce, …)
  TypeCode?: number;
  /** SubscriptionChange specifics. */
  SuppressSending?: boolean;
  // Loose: tolerate any other Postmark fields.
  [key: string]: unknown;
}

/** The normalized result of mapping one Postmark record. */
export interface PostmarkMapping {
  /** The raw provider record type, verbatim. */
  recordType: string;
  /** The suite engagement kind, or null for a pure delivery/status signal. */
  normalizedKind: EmailEngagementKind | null;
  /** The status this record implies, or null for engagement-only. */
  statusTarget: EmailMessageStatus | null;
  /** The provider message id (resolves the owning EmailMessage). */
  providerMessageId: string | null;
  /** The provider dedupe key for THIS record (idempotency anchor). */
  providerEventId: string;
  /** When the event occurred (provider timestamp), or null. */
  occurredAt: Date | null;
}

/** Is `t` a record type Email-Ops handles? */
export function isHandledRecordType(t: string | undefined): t is PostmarkRecordType {
  return (
    t === 'Delivery' ||
    t === 'Open' ||
    t === 'Click' ||
    t === 'Bounce' ||
    t === 'SpamComplaint' ||
    t === 'SubscriptionChange'
  );
}

/** Parse a provider timestamp to a Date, or null if absent/invalid. */
function parseTs(...candidates: Array<unknown>): Date | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/**
 * Map one Postmark webhook body → the normalized engagement signal.
 *
 * The (recordType → kind, status) table (the brief's per-record-type contract):
 *   Delivery           → kind=null,         status=DELIVERED   (delivery signal)
 *   Open               → kind=OPENED,       status=null        (engagement only)
 *   Click              → kind=CLICKED,      status=null        (engagement only)
 *   Bounce             → kind=BOUNCED,      status=BOUNCED     (terminal failure)
 *   SpamComplaint      → kind=UNSUBSCRIBED, status=null        (engagement only)
 *   SubscriptionChange → kind=UNSUBSCRIBED, status=null        (engagement only)
 *
 * Rationale for the unsubscribed mapping: the suite's normalized vocabulary has
 * no distinct "spam complaint" kind — a spam complaint is the strongest possible
 * unsubscribe signal, so it normalizes to `unsubscribed` (matching Customer-Ops'
 * EngagementKind). A SubscriptionChange with SuppressSending=false (a RE-subscribe
 * / suppression removal) is NOT an unsubscribe — it maps to null kind (captured
 * for audit, but it advances nothing).
 *
 * Returns null ONLY when the record type is not one we handle (the caller treats
 * that as an ignored-but-ACKed record).
 */
export function mapPostmarkRecord(body: PostmarkWebhookBody): PostmarkMapping | null {
  const recordType = body.RecordType;
  if (!isHandledRecordType(recordType)) return null;

  const messageId = typeof body.MessageID === 'string' ? body.MessageID : null;

  // The provider dedupe key. Bounce + SpamComplaint carry a stable numeric `ID`;
  // engagement/delivery records do not, so we synthesize a deterministic key
  // from (MessageID + RecordType + best timestamp) — stable across re-deliveries
  // of the SAME event, distinct across different events for the same message.
  const occurredAt = parseTs(body.DeliveredAt, body.BouncedAt, body.ChangedAt, body.ReceivedAt);
  const providerEventId = deriveEventId(body, recordType, occurredAt);

  switch (recordType) {
    case 'Delivery':
      return {
        recordType,
        normalizedKind: null,
        statusTarget: EmailMessageStatus.DELIVERED,
        providerMessageId: messageId,
        providerEventId,
        occurredAt,
      };
    case 'Open':
      return {
        recordType,
        normalizedKind: EmailEngagementKind.OPENED,
        statusTarget: null,
        providerMessageId: messageId,
        providerEventId,
        occurredAt,
      };
    case 'Click':
      return {
        recordType,
        normalizedKind: EmailEngagementKind.CLICKED,
        statusTarget: null,
        providerMessageId: messageId,
        providerEventId,
        occurredAt,
      };
    case 'Bounce':
      return {
        recordType,
        normalizedKind: EmailEngagementKind.BOUNCED,
        statusTarget: EmailMessageStatus.BOUNCED,
        providerMessageId: messageId,
        providerEventId,
        occurredAt,
      };
    case 'SpamComplaint':
      return {
        recordType,
        normalizedKind: EmailEngagementKind.UNSUBSCRIBED,
        statusTarget: null,
        providerMessageId: messageId,
        providerEventId,
        occurredAt,
      };
    case 'SubscriptionChange': {
      // A real unsubscribe (SuppressSending=true) → unsubscribed; a re-subscribe
      // / suppression removal (false) is captured but is not an unsubscribe.
      const isUnsub = body.SuppressSending !== false;
      return {
        recordType,
        normalizedKind: isUnsub ? EmailEngagementKind.UNSUBSCRIBED : null,
        statusTarget: null,
        providerMessageId: messageId,
        providerEventId,
        occurredAt,
      };
    }
  }
}

/**
 * Derive the idempotency key for a Postmark record. Prefer the provider's own
 * stable id (`ID`, present on Bounce/SpamComplaint). Otherwise synthesize a
 * deterministic key so a webhook re-delivery of the SAME engagement/delivery
 * event dedupes, while distinct events for the same message stay distinct.
 */
export function deriveEventId(
  body: PostmarkWebhookBody,
  recordType: string,
  occurredAt: Date | null,
): string {
  if (body.ID !== undefined && body.ID !== null && `${body.ID}`.trim()) {
    return `postmark:${recordType}:${body.ID}`;
  }
  const mid = typeof body.MessageID === 'string' ? body.MessageID : 'no-mid';
  // For engagement records Postmark may send a per-open/per-click event; the
  // timestamp distinguishes repeated opens, and a re-delivery of the same open
  // carries the same timestamp → same key (idempotent). When even the timestamp
  // is absent we fall back to MessageID+RecordType (coarsest dedupe).
  const ts = occurredAt ? occurredAt.toISOString() : 'no-ts';
  return `postmark:${recordType}:${mid}:${ts}`;
}
