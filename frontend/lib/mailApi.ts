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

import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api';

/** The folders a thread list can be scoped to (the segmented control). */
export type MailFolder = 'inbox' | 'archive' | 'spam' | 'trash' | 'sent' | 'drafts';

/** Where a thread currently sits (the triage overlay disposition). */
export type ThreadDisposition = 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM';

/** A participant on a thread / message (sender or recipient). */
export interface MailParticipant {
  address: string;
  name: string | null;
}

/** The mail backend each mailbox reads/sends through. */
export type MailboxProvider = 'stalwart' | 'gmail' | 'microsoft';

/** One mailbox the signed-in caller can open in the mail client (the picker). */
export interface MailboxPick {
  id: string;
  email_address: string;
  display_name: string | null;
  owner_kind: 'HUMAN' | 'AGENT' | 'SHARED';
  kind: string;
  /**
   * Which backend this mailbox reads/sends through: 'stalwart' is the sovereign
   * mailbox, 'gmail'/'microsoft' are connected external accounts. Optional on the
   * wire for backward compatibility (older rows may omit it).
   */
  provider?: MailboxProvider;
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
  /** Where the thread currently sits (the triage overlay). Optional on the wire. */
  disposition?: ThreadDisposition;
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

/** A sender-policy rule targets a single ADDRESS or a whole DOMAIN. */
export type SenderScope = 'ADDRESS' | 'DOMAIN';

/** A sender-policy rule either BLOCKs or ALLOWs (trusts) the matched sender. */
export type SenderKind = 'BLOCK' | 'ALLOW';

/** One sender block/allow rule (mirrors the backend SenderPolicyView). */
export interface SenderPolicyView {
  id: string;
  scope: SenderScope;
  pattern: string;
  kind: SenderKind;
  reason: string | null;
  set_by_uc_uid: string | null;
  set_by_agent_key: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Body for the triage call. `block_sender` / `trust_sender` (+ the matching
 * `sender_address`) let a triage also write a sender policy in the same request
 * — e.g. marking SPAM blocks the sender; "Not spam" trusts them.
 */
export interface SetDispositionBody {
  disposition: ThreadDisposition;
  block_sender?: boolean;
  trust_sender?: boolean;
  sender_address?: string;
}

/** The disposition projection echoed back by the triage call. */
export interface ThreadDispositionView {
  thread_id: string;
  disposition: ThreadDisposition;
  set_by_uc_uid: string | null;
  set_by_agent_key: string | null;
  updated_at: string;
}

/** Result of a triage: the new disposition + any sender policy it wrote. */
export interface SetDispositionResponse {
  disposition: ThreadDispositionView;
  sender_policy: SenderPolicyView | null;
}

/** Body for creating a sender block/allow rule. */
export interface SenderPolicyBody {
  scope: SenderScope;
  pattern: string;
  kind: SenderKind;
  reason?: string;
}

export interface SenderPoliciesResponse {
  items: SenderPolicyView[];
  count: number;
}

export interface MailMailboxesResponse {
  items: MailboxPick[];
  count: number;
}

export interface MailThreadsResponse {
  threads: ThreadView[];
  count: number;
  /** Echoes the folder the list was scoped to (defaults to inbox server-side). */
  folder?: string;
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

/** Body for registering the caller's own connected (external) account as a mailbox. */
export interface ConnectMailboxBody {
  provider: 'gmail' | 'microsoft';
  email_address: string;
  display_name?: string;
}

/**
 * Register the caller's OWN linked Gmail/M365 account as a workspace mailbox so
 * it appears in `/mail` and reads/sends through that provider. The OAuth token
 * stays in the Keycloak broker — this just creates the mailbox row pointing at
 * the connected account. Idempotent on `email_address`; returns the created (or
 * existing) mailbox in the same `MailboxPick` shape the picker renders.
 */
export async function connectMailbox(
  workspaceId: string,
  body: ConnectMailboxBody,
  token?: string,
): Promise<MailboxPick> {
  return apiPost<MailboxPick>(`/workspaces/${seg(workspaceId)}/mailboxes/connected`, body, token);
}

/**
 * List the threads in a mailbox folder, newest-first (defaults to 50, inbox).
 * `folder` ∈ inbox | archive | spam | trash | sent | drafts.
 */
export async function listMailThreads(
  workspaceId: string,
  mailboxId: string,
  limit = 50,
  folder: MailFolder = 'inbox',
  token?: string,
): Promise<MailThreadsResponse> {
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
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

const mailScope = (workspaceId: string) => `/workspaces/${seg(workspaceId)}/mail`;

/**
 * Triage a thread — move it to a folder (the disposition overlay), optionally
 * blocking or trusting the other party in the same call. Note the route is
 * workspace-scoped, NOT under a mailbox. Writes even when the engine is dormant.
 */
export async function setThreadDisposition(
  workspaceId: string,
  threadId: string,
  body: SetDispositionBody,
  token?: string,
): Promise<SetDispositionResponse> {
  return apiPut<SetDispositionResponse>(
    `${mailScope(workspaceId)}/threads/${seg(threadId)}/disposition`,
    body,
    token,
  );
}

/** List the workspace's sender block/allow rules. */
export async function listSenderPolicies(
  workspaceId: string,
  token?: string,
): Promise<SenderPoliciesResponse> {
  return apiGet<SenderPoliciesResponse>(`${mailScope(workspaceId)}/sender-policies`, token);
}

/** Create a sender block/allow rule. Returns the created rule. */
export async function setSenderPolicy(
  workspaceId: string,
  body: SenderPolicyBody,
  token?: string,
): Promise<SenderPolicyView> {
  return apiPost<SenderPolicyView>(`${mailScope(workspaceId)}/sender-policies`, body, token);
}

/** Remove a sender block/allow rule by id (404 if it is already gone). */
export async function removeSenderPolicy(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<{ removed: boolean }> {
  return apiDelete<{ removed: boolean }>(
    `${mailScope(workspaceId)}/sender-policies/${seg(id)}`,
    token,
  );
}
