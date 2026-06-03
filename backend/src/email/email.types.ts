/**
 * Email-Ops wire shapes — the EmailOpsPort federation contract.
 *
 * BINDING: these snake_case shapes MUST match the contract Customer-Ops calls
 * (its backend/src/email-ops/email-ops.types.ts + email-ops.client.ts) so the
 * cockpit federates Email-Ops for real. The MCP server emits exactly these as
 * the tool `structuredContent`:
 *   - list_threads_with_contact -> { threads: ThreadView[] }
 *   - list_thread_messages      -> { messages: MessageView[] }
 *   - compose_email             -> MessageComposeView
 *
 * The cockpit's client maps `message_count`→messageCount, `last_message_at`→
 * lastMessageAt, etc. — so the field NAMES below are load-bearing.
 */

/** One participant on a thread/message (a from/to/cc address). */
export interface ParticipantView {
  address: string;
  name: string | null;
}

/** A mailbox thread with a contact (the customer-360 email history row). */
export interface ThreadView {
  id: string;
  subject: string | null;
  message_count: number;
  unread: boolean;
  last_message_at: string | null;
  last_snippet: string | null;
  participants: ParticipantView[];
}

/** One message within a thread (bodies as previews only). */
export interface MessageView {
  id: string;
  thread_id: string;
  from: ParticipantView | null;
  to: ParticipantView[];
  subject: string | null;
  sent_at: string | null;
  preview: string | null;
  direction: string; // received | sent | draft
}

/**
 * The result of a compose (send/draft). Echoed back so the cockpit caches a thin
 * projection on its link row. IDEMPOTENT: a repeat with the same
 * (workspace_id, external_source, external_ref) returns the EXISTING message.
 */
export interface MessageComposeView {
  id: string;
  thread_id: string | null;
  status: string; // queued|sent|delivered|draft|pending_approval|rejected|failed
  mode: string; // send | draft
  external_source: string | null;
  external_ref: string | null;
  created_at: string | null;
}

/** Internal: the parsed compose request the service acts on. */
export interface ComposeInput {
  contactId: string | null;
  toAddress: string;
  subject: string;
  body: string;
  mode: 'send' | 'draft';
  inReplyToThreadId?: string | null;
  externalSource: string;
  externalRef: string;
  draftedBy?: string | null;
}

/** An agent-inbox item view (the approval queue surface). */
export interface AgentInboxView {
  id: string;
  message_id: string;
  state: string; // pending | approved | rejected
  drafted_by: string | null;
  summary: string | null;
  to_address: string | null;
  subject: string | null;
  reviewed_by_uc_uid: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string | null;
}
