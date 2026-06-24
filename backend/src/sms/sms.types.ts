/**
 * SMS channel wire types. The compose input + the views the (future) REST/MCP
 * surface returns — shaped like the email contract so a cockpit treats SMS and
 * email uniformly (channel discriminator + the same idempotency tuple).
 */

export interface ComposeSmsInput {
  contactId?: string | null;
  toPhoneNumber: string;
  body: string;
  mode?: 'send' | 'draft';
  /** Idempotency tuple with externalRef (the originating app, e.g. 'customer-ops'). */
  externalSource: string;
  externalRef: string;
  /** Provenance: the agent/source key that drafted this (drives the autonomy dial). */
  draftedBy?: string | null;
  /** Explicit send-from line; falls back to the workspace default SMS account. */
  fromSmsAccountId?: string | null;
  inReplyToThreadId?: string | null;
}

export interface SmsComposeView {
  id: string;
  channel: 'sms';
  thread_id: string | null;
  status: string;
  mode: string;
  to: string | null;
  external_source: string | null;
  external_ref: string | null;
  created_at: string | null;
}

export interface SmsInboxView {
  id: string;
  sms_message_id: string | null;
  channel: 'sms';
  state: string;
  drafted_by: string | null;
  summary: string | null;
  to: string | null;
  body_preview: string | null;
  reviewed_by_uc_uid: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string | null;
}

export interface InboundSmsInput {
  provider: 'twilio';
  /** Twilio MessageSid — the idempotency key for re-delivered inbound webhooks. */
  providerMessageId: string;
  fromPhoneNumber: string;
  /** The workspace's own line the message came in on (resolves the workspace). */
  toPhoneNumber: string;
  body: string;
  occurredAt?: Date | null;
}

export interface InboundSmsResult {
  outcome: 'recorded' | 'duplicate' | 'unmatched';
  workspaceId: string | null;
  smsMessageId: string | null;
}
