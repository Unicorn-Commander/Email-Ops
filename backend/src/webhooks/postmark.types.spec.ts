import { EmailEngagementKind, EmailMessageStatus } from '@prisma/client';
import {
  deriveEventId,
  isHandledRecordType,
  mapPostmarkRecord,
  PostmarkWebhookBody,
} from './postmark.types';

/**
 * Pure mapping tests for the Postmark webhook → normalized engagement signal.
 *
 * These assert the brief's per-record-type contract directly (no DB, no auth):
 * every handled Postmark RecordType maps to the right (normalizedKind, statusTarget)
 * pair in the suite's normalized vocabulary, and the dedupe-key derivation is
 * stable across re-deliveries of the same event.
 */
describe('mapPostmarkRecord (per-record-type contract)', () => {
  const base = (over: Partial<PostmarkWebhookBody>): PostmarkWebhookBody => ({
    MessageID: 'pm-msg-123',
    ...over,
  });

  it('Delivery → kind=null (delivery signal), status=DELIVERED', () => {
    const m = mapPostmarkRecord(base({ RecordType: 'Delivery', DeliveredAt: '2026-06-03T10:00:00Z' }));
    expect(m).toBeTruthy();
    expect(m!.normalizedKind).toBeNull();
    expect(m!.statusTarget).toBe(EmailMessageStatus.DELIVERED);
    expect(m!.providerMessageId).toBe('pm-msg-123');
    expect(m!.occurredAt?.toISOString()).toBe('2026-06-03T10:00:00.000Z');
  });

  it('Open → kind=OPENED, status=null (engagement only)', () => {
    const m = mapPostmarkRecord(base({ RecordType: 'Open', ReceivedAt: '2026-06-03T11:00:00Z' }));
    expect(m!.normalizedKind).toBe(EmailEngagementKind.OPENED);
    expect(m!.statusTarget).toBeNull();
  });

  it('Click → kind=CLICKED, status=null (engagement only)', () => {
    const m = mapPostmarkRecord(base({ RecordType: 'Click', ReceivedAt: '2026-06-03T11:30:00Z' }));
    expect(m!.normalizedKind).toBe(EmailEngagementKind.CLICKED);
    expect(m!.statusTarget).toBeNull();
  });

  it('Bounce → kind=BOUNCED, status=BOUNCED (terminal failure); uses provider ID for dedupe', () => {
    const m = mapPostmarkRecord(
      base({ RecordType: 'Bounce', ID: 9991, Type: 'HardBounce', BouncedAt: '2026-06-03T12:00:00Z' }),
    );
    expect(m!.normalizedKind).toBe(EmailEngagementKind.BOUNCED);
    expect(m!.statusTarget).toBe(EmailMessageStatus.BOUNCED);
    // A Bounce carries Postmark's own numeric ID → that anchors the dedupe key.
    expect(m!.providerEventId).toBe('postmark:Bounce:9991');
  });

  it('SpamComplaint → kind=UNSUBSCRIBED, status=null (strongest unsubscribe signal)', () => {
    const m = mapPostmarkRecord(base({ RecordType: 'SpamComplaint', ID: 7, BouncedAt: '2026-06-03T12:30:00Z' }));
    expect(m!.normalizedKind).toBe(EmailEngagementKind.UNSUBSCRIBED);
    expect(m!.statusTarget).toBeNull();
    expect(m!.providerEventId).toBe('postmark:SpamComplaint:7');
  });

  it('SubscriptionChange (SuppressSending=true) → kind=UNSUBSCRIBED, status=null', () => {
    const m = mapPostmarkRecord(
      base({ RecordType: 'SubscriptionChange', SuppressSending: true, ChangedAt: '2026-06-03T13:00:00Z' }),
    );
    expect(m!.normalizedKind).toBe(EmailEngagementKind.UNSUBSCRIBED);
    expect(m!.statusTarget).toBeNull();
  });

  it('SubscriptionChange (SuppressSending=false, a re-subscribe) → kind=null (captured, not an unsubscribe)', () => {
    const m = mapPostmarkRecord(
      base({ RecordType: 'SubscriptionChange', SuppressSending: false, ChangedAt: '2026-06-03T13:30:00Z' }),
    );
    expect(m).toBeTruthy();
    expect(m!.normalizedKind).toBeNull();
    expect(m!.statusTarget).toBeNull();
  });

  it('an unhandled record type → null (ignored)', () => {
    expect(mapPostmarkRecord(base({ RecordType: 'Inbound' }))).toBeNull();
    expect(mapPostmarkRecord(base({ RecordType: undefined }))).toBeNull();
    expect(isHandledRecordType('Inbound')).toBe(false);
    expect(isHandledRecordType('Delivery')).toBe(true);
  });

  it('a missing MessageID surfaces as providerMessageId=null (the receiver ACKs it as unmatched)', () => {
    const m = mapPostmarkRecord({ RecordType: 'Open', MessageID: undefined });
    expect(m).toBeTruthy();
    expect(m!.providerMessageId).toBeNull();
  });
});

describe('deriveEventId (idempotency anchor)', () => {
  it('prefers the provider ID when present (stable across re-delivery)', () => {
    const id1 = deriveEventId({ RecordType: 'Bounce', ID: 42, MessageID: 'm1' }, 'Bounce', new Date());
    const id2 = deriveEventId({ RecordType: 'Bounce', ID: 42, MessageID: 'm1' }, 'Bounce', new Date(Date.now() + 5000));
    expect(id1).toBe('postmark:Bounce:42');
    // The provider ID dominates → the key is identical even if the timestamp differs.
    expect(id2).toBe(id1);
  });

  it('synthesizes a deterministic key from MessageID+RecordType+timestamp when no provider ID', () => {
    const ts = new Date('2026-06-03T10:00:00Z');
    const a = deriveEventId({ RecordType: 'Open', MessageID: 'm9' }, 'Open', ts);
    const b = deriveEventId({ RecordType: 'Open', MessageID: 'm9' }, 'Open', ts);
    // Same event re-delivered (same ts) → same key (idempotent).
    expect(a).toBe(b);
    expect(a).toBe('postmark:Open:m9:2026-06-03T10:00:00.000Z');
    // A different open (different ts) → a distinct key.
    const c = deriveEventId({ RecordType: 'Open', MessageID: 'm9' }, 'Open', new Date('2026-06-03T10:05:00Z'));
    expect(c).not.toBe(a);
  });
});
