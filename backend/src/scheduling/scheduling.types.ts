import { ScheduledSendState, SnoozedThreadState } from '@prisma/client';

export interface SchedulingUser {
  id?: string;
  keycloakId?: string | null;
  __ucUid?: string | null;
}

export interface SnoozeThreadInput {
  workspaceId: string;
  mailboxId: string;
  threadId: string;
  until: Date;
  /** Optional caller-supplied thread subject for the Snoozed view (the webmail
   *  reader has it in hand). When absent the service resolves it best-effort. */
  subject?: string | null;
}

export interface SnoozedThreadView {
  id: string;
  mailbox_id: string;
  thread_id: string;
  /** Thread subject captured at snooze time; null for agent snoozes / dormant engine. */
  subject: string | null;
  snooze_until: string;
  state: string;
  created_by: string | null;
  created_at: string;
}

export interface ScheduledSendPayload {
  toAddress: string;
  toAddresses?: string[];
  subject: string;
  body: string;
  bodyHtml?: string | null;
  cc?: string[];
  bcc?: string[];
  attachments?: { blob_id: string; name: string; type: string }[];
  inReplyToThreadId?: string | null;
  inReplyToMessageId?: string | null;
  references?: string[];
  draftId?: string | null;
}

export interface ScheduledSendView {
  id: string;
  mailbox_id: string;
  payload: ScheduledSendPayload;
  send_at: string;
  state: string;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
}

export type SnoozeState = SnoozedThreadState;
export type SendState = ScheduledSendState;
