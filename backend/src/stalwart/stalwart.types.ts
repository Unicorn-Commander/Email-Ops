/**
 * The Stalwart mail-engine wire shapes.
 *
 * Email-Ops FRONTS the Stalwart mail server (IMAP/JMAP) for mailbox state +
 * threads (SUITE-ARCHITECTURE-MAP §3: Stalwart = "Mail server (IMAP/JMAP) —
 * mailboxes/receiving", fronted by Email-Ops). These are the shapes the
 * StalwartPort returns to the Email-Ops service layer; the service maps them
 * onto the SoR rows + the EmailOpsPort federation contract.
 *
 * "Federate the engine, don't reinvent a mail server": these shapes are
 * informed by JMAP (Thread / Email objects) so Stalwart's native model maps
 * cleanly. Transactional OUTBOUND routes via Postmark (the high-rep lane); the
 * mailbox read path is Stalwart.
 */

/** One from/to/cc participant on a thread or message (a JMAP EmailAddress). */
export interface StalwartParticipant {
  address: string;
  name: string | null;
}

/** A mailbox thread (a JMAP Thread / IMAP conversation). */
export interface StalwartThread {
  /** The provider thread id (JMAP threadId). Opaque above this layer. */
  id: string;
  subject: string | null;
  messageCount: number;
  unread: boolean;
  /** ISO-8601 of the most recent message in the thread. */
  lastMessageAt: string | null;
  /** A short snippet/preview of the latest message (no full body). */
  lastSnippet: string | null;
  /** The distinct participants across the thread (deduped). */
  participants: StalwartParticipant[];
}

/** One message in a thread (a JMAP Email / IMAP message). Bodies are previews. */
export interface StalwartMessage {
  id: string;
  threadId: string;
  from: StalwartParticipant | null;
  to: StalwartParticipant[];
  subject: string | null;
  /** ISO-8601 sent/received time. */
  sentAt: string | null;
  /** A preview/snippet of the body (NOT the full message). */
  preview: string | null;
  /** received | sent | draft (the message's direction/state in the mailbox). */
  direction: 'received' | 'sent' | 'draft';
}

/**
 * A request to send (or stage a draft of) an outbound message through the
 * mail engine. The lane is chosen by the service:
 *   - transactional sends route via Postmark (high-rep);
 *   - everything else via Stalwart SMTP/JMAP.
 */
export interface StalwartSendRequest {
  /** The workspace's deliverable identity (the From mailbox). */
  fromAddress: string;
  fromName?: string | null;
  toAddress: string;
  subject: string;
  /** Plain-text body. */
  body: string;
  /** The thread to reply within (so the engine threads the reply). */
  inReplyToThreadId?: string | null;
}

/**
 * The result of handing a message to the mail engine for delivery.
 * `accepted=false` means the engine rejected/queued-failed it (the service
 * records FAILED). On accept, the provider message + thread ids are echoed.
 */
export interface StalwartSendResult {
  accepted: boolean;
  /** The provider message id (Stalwart/Postmark message id). */
  providerMessageId: string | null;
  /** The thread the message landed in (new or the replied-to thread). */
  threadId: string | null;
  /** Which deliverability lane carried it: 'stalwart' | 'james' | 'postmark'. */
  lane: 'stalwart' | 'james' | 'postmark' | null;
  /** A human reason on rejection (logged). */
  reason?: string | null;
}
