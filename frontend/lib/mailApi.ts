/**
 * Typed browser client for the Email-Ops mail client ("retire Outlook" surface).
 *
 * This is the read-your-inboxes + compose data layer that backs `/mail`. Every
 * route is workspace-scoped (the tenancy seam — see the backend RLS chokepoint),
 * so each call takes a `workspaceId`; the page resolves the active workspace via
 * `pickActiveWorkspace` exactly like the agent-inbox does.
 *
 * Wire shapes are snake_case and mirror the backend contracts verbatim — this
 * module does no remapping, it just types them. It deliberately reuses the
 * shared `apiGet`/`apiPost` from `@/lib/api` (auth, error extraction, JSON) and
 * never edits that file.
 *
 * Degrade-clean note: the mail engine may be DORMANT. In that state `threads`
 * comes back EMPTY and a compose returns `status: 'failed'` (recorded, not sent).
 * That is expected — the UI reports it honestly rather than treating it as an
 * error. These types therefore keep `status`/nullable fields faithful to the
 * wire so the page can render the truth.
 */

import { apiGet, apiPost } from '@/lib/api';

/** A participant on a thread / message (sender or recipient). */
export interface MailParticipant {
  address: string;
  name: string | null;
}

/** One mailbox the signed-in caller can open in the mail client (the picker). */
export interface MailboxPick {
  id: string;
  email_address: string;
  display_name: string | null;
  owner_kind: 'HUMAN' | 'AGENT' | 'SHARED';
  kind: string;
}

/** A row in the thread list for a mailbox (mirrors the backend ThreadView). */
export interface ThreadView {
  id: string;
  subject: string | null;
  message_count: number;
  unread: boolean;
  last_message_at: string | null;
  last_snippet: string | null;
  participants: MailParticipant[];
}

/** One message inside a thread (mirrors the backend MessageView). */
export interface MessageView {
  id: string;
  thread_id: string;
  from: MailParticipant | null;
  to: MailParticipant[];
  subject: string | null;
  sent_at: string | null;
  preview: string | null;
  /** received | sent | draft */
  direction: string;
}

/**
 * The projection echoed back by compose/reply. `status` is load-bearing: when
 * the mail engine is dormant it comes back as `'failed'` (recorded, will send
 * once the engine is live) — the UI surfaces this verbatim, not as an error.
 */
export interface MessageComposeView {
  id: string;
  thread_id: string | null;
  status: string;
  mode: string;
  external_source: string | null;
  external_ref: string | null;
  created_at: string | null;
}

/** Body for compose / reply. `in_reply_to_thread_id` threads a reply. */
export interface ComposeBody {
  to_address: string;
  subject?: string;
  body?: string;
  in_reply_to_thread_id?: string;
}

export interface MailMailboxesResponse {
  items: MailboxPick[];
  count: number;
}

export interface MailThreadsResponse {
  threads: ThreadView[];
  count: number;
}

export interface MailThreadResponse {
  messages: MessageView[];
  count: number;
}

const seg = encodeURIComponent;

const mailBase = (workspaceId: string, mailboxId: string) =>
  `/workspaces/${seg(workspaceId)}/mail/${seg(mailboxId)}`;

/**
 * List the workspace's mailboxes — the inbox picker. Same route the mailbox
 * cockpit reads; typed here as the narrower `MailboxPick` the client needs.
 */
export async function listMailMailboxes(
  workspaceId: string,
  token?: string,
): Promise<MailMailboxesResponse> {
  return apiGet<MailMailboxesResponse>(`/workspaces/${seg(workspaceId)}/mailboxes`, token);
}

/** List the threads in a mailbox, newest-first (defaults to 50). */
export async function listMailThreads(
  workspaceId: string,
  mailboxId: string,
  limit = 50,
  token?: string,
): Promise<MailThreadsResponse> {
  const qs = limit ? `?limit=${seg(String(limit))}` : '';
  return apiGet<MailThreadsResponse>(`${mailBase(workspaceId, mailboxId)}/threads${qs}`, token);
}

/** Fetch the messages of a single thread, in order. */
export async function getMailThread(
  workspaceId: string,
  mailboxId: string,
  threadId: string,
  token?: string,
): Promise<MailThreadResponse> {
  return apiGet<MailThreadResponse>(
    `${mailBase(workspaceId, mailboxId)}/threads/${seg(threadId)}`,
    token,
  );
}

/**
 * Compose a new message, or reply within a thread (set `in_reply_to_thread_id`).
 * Returns the recorded message projection — inspect `status`: `'failed'` means
 * recorded-but-not-sent (the engine is dormant), not an error.
 */
export async function composeMail(
  workspaceId: string,
  mailboxId: string,
  body: ComposeBody,
  token?: string,
): Promise<MessageComposeView> {
  return apiPost<MessageComposeView>(`${mailBase(workspaceId, mailboxId)}/compose`, body, token);
}
