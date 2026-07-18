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

import { API_BASE, ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut, getToken } from '@/lib/api';

/**
 * Feature detection for the Wave-2 endpoints (aggregate / counts / read / blobs
 * / attachments / bulk). Those may not be deployed yet: a 404 or 501 from one of
 * them means "not there", and the UI hides the affordance instead of erroring.
 */
export function isMissingEndpoint(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

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
  flagged?: boolean;
  last_message_at: string | null;
  last_snippet: string | null;
  participants: MailParticipant[];
  /** Where the thread currently sits (the triage overlay). Optional on the wire. */
  disposition?: ThreadDisposition;
  /** Whether any message in the thread carries an attachment (Wave 2, optional). */
  has_attachments?: boolean;
  /** Present on aggregate ("All inboxes") rows: which mailbox the thread lives in. */
  mailbox_id?: string;
  /** Present on aggregate rows: that mailbox's address (for the per-account tag). */
  mailbox_address?: string;
}

/** One attachment on a message (Wave 2). `cid` links inline images. */
export interface MailAttachment {
  blob_id: string;
  name: string | null;
  type: string | null;
  size: number | null;
  cid: string | null;
}

/** One message inside a thread (mirrors the backend MessageView). */
export interface MessageView {
  id: string;
  thread_id: string;
  from: MailParticipant | null;
  to: MailParticipant[];
  /** CC recipients (Wave 2, optional on the wire). */
  cc?: MailParticipant[];
  /** BCC recipients (Wave 2, optional on the wire). */
  bcc?: MailParticipant[];
  subject: string | null;
  sent_at: string | null;
  preview: string | null;
  /** received | sent | draft */
  direction: string;
  /** RAW UNSANITIZED HTML body (Wave 2) — must be sanitized before rendering. */
  html_body?: string | null;
  /** Plain-text body (Wave 2). */
  text_body?: string | null;
  /** Per-message unread flag (Wave 2). */
  is_unread?: boolean;
  flagged?: boolean;
  /** Attachments (Wave 2). */
  attachments?: MailAttachment[];
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

/** A blob reference included in a compose (already uploaded via the attachments endpoint). */
export interface ComposeAttachmentRef {
  blob_id: string;
  name: string;
  type: string;
}

/**
 * Body for compose / reply. `in_reply_to_thread_id` threads a reply.
 * Wave 2 adds cc/bcc, uploaded-blob attachment refs, and the RFC-5322 threading
 * hints `in_reply_to` / `references` (message ids; the backend resolves headers).
 * NOTE: multiple To recipients are sent comma-joined in `to_address`.
 */
export interface ComposeBody {
  to_address: string;
  subject?: string;
  body?: string;
  body_html?: string;
  in_reply_to_thread_id?: string;
  draft_id?: string | null;
  cc?: string[];
  bcc?: string[];
  attachments?: ComposeAttachmentRef[];
  in_reply_to?: string;
  references?: string[];
}

export interface DraftSaveResponse {
  draft_id: string | null;
  updated: boolean;
}

export interface MailVacationSettings {
  id: string;
  mailbox_account_id: string;
  enabled: boolean;
  subject: string;
  body_html: string;
  body_text: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
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

export interface MailSignature {
  id: string;
  mailbox_account_id: string;
  name: string;
  html: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface MailSignaturesResponse {
  items: MailSignature[];
  count: number;
}

export interface SaveMailSignatureBody {
  name: string;
  html: string;
  is_default?: boolean;
}

export interface MailContact {
  id: string;
  mailbox_account_id: string;
  email: string;
  display_name: string | null;
  last_seen_at: string;
  frequency: number;
}

export interface MailContactsResponse {
  items: MailContact[];
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

const mailboxBase = (workspaceId: string, mailboxId: string) =>
  `/workspaces/${seg(workspaceId)}/mailboxes/${seg(mailboxId)}`;

export async function listMailSignatures(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<MailSignaturesResponse> {
  return apiGet<MailSignaturesResponse>(`${mailboxBase(workspaceId, mailboxId)}/signatures`, token);
}

export async function createMailSignature(
  workspaceId: string,
  mailboxId: string,
  body: SaveMailSignatureBody,
  token?: string,
): Promise<MailSignature> {
  return apiPost<MailSignature>(`${mailboxBase(workspaceId, mailboxId)}/signatures`, body, token);
}

export async function updateMailSignature(
  workspaceId: string,
  mailboxId: string,
  signatureId: string,
  body: Partial<SaveMailSignatureBody>,
  token?: string,
): Promise<MailSignature> {
  return apiPatch<MailSignature>(
    `${mailboxBase(workspaceId, mailboxId)}/signatures/${seg(signatureId)}`,
    body,
    token,
  );
}

export async function setDefaultMailSignature(
  workspaceId: string,
  mailboxId: string,
  signatureId: string,
  token?: string,
): Promise<MailSignature> {
  return apiPost<MailSignature>(
    `${mailboxBase(workspaceId, mailboxId)}/signatures/${seg(signatureId)}/default`,
    {},
    token,
  );
}

export async function deleteMailSignature(
  workspaceId: string,
  mailboxId: string,
  signatureId: string,
  token?: string,
): Promise<{ removed: boolean }> {
  return apiDelete<{ removed: boolean }>(
    `${mailboxBase(workspaceId, mailboxId)}/signatures/${seg(signatureId)}`,
    token,
  );
}

export async function searchMailContacts(
  workspaceId: string,
  mailboxId: string,
  q: string,
  token?: string,
): Promise<MailContactsResponse> {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiGet<MailContactsResponse>(`${mailboxBase(workspaceId, mailboxId)}/contacts${qs}`, token);
}

/** Options for a thread-list read (single-mailbox or aggregate). */
export interface ListThreadsOpts {
  folder?: MailFolder;
  limit?: number;
  /** Full-text search (Wave 2). Omitted when empty. */
  q?: string;
  /** Load-more paging offset (Wave 2). */
  offset?: number;
}

function threadsQs(opts: ListThreadsOpts): string {
  const params = new URLSearchParams();
  params.set('folder', opts.folder ?? 'inbox');
  params.set('limit', String(opts.limit ?? 50));
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  if (opts.offset) params.set('offset', String(opts.offset));
  return `?${params.toString()}`;
}

/**
 * List the threads in a mailbox folder, newest-first (defaults to 50, inbox).
 * `folder` ∈ inbox | archive | spam | trash | sent | drafts.
 */
export async function listMailThreads(
  workspaceId: string,
  mailboxId: string,
  opts: ListThreadsOpts = {},
  token?: string,
): Promise<MailThreadsResponse> {
  return apiGet<MailThreadsResponse>(
    `${mailBase(workspaceId, mailboxId)}/threads${threadsQs(opts)}`,
    token,
  );
}

/**
 * Unified "All inboxes" thread list across every mailbox in the workspace
 * (Wave 2). Rows carry `mailbox_id` + `mailbox_address` so the UI can tag them
 * and route opens/replies to the right mailbox. 404/501 → feature not deployed.
 * Tolerates either `threads` or `items` as the list key.
 */
export async function listAggregateThreads(
  workspaceId: string,
  opts: ListThreadsOpts = {},
  token?: string,
): Promise<MailThreadsResponse> {
  const raw = await apiGet<{ threads?: ThreadView[]; items?: ThreadView[]; count?: number; folder?: string }>(
    `/workspaces/${seg(workspaceId)}/mail/threads/aggregate${threadsQs(opts)}`,
    token,
  );
  const threads = raw.threads ?? raw.items ?? [];
  return { threads, count: raw.count ?? threads.length, folder: raw.folder };
}

/** Per-mailbox inbox counts (Wave 2) — feeds the unread badges in the picker. */
export interface MailboxCounts {
  mailbox_id: string;
  address: string;
  inbox_unread: number;
  inbox_total: number;
  /** Set when this mailbox's engine read failed; counts may be stale/zero. */
  error?: string | null;
}

export interface MailCountsResponse {
  mailboxes: MailboxCounts[];
}

/** Fetch per-mailbox inbox unread/total counts (Wave 2). 404/501 → hide badges. */
export async function getMailCounts(
  workspaceId: string,
  token?: string,
): Promise<MailCountsResponse> {
  return apiGet<MailCountsResponse>(`/workspaces/${seg(workspaceId)}/mail/counts`, token);
}

/** Mark a whole thread read/unread (Wave 2). 404/501 → feature not deployed. */
export async function setThreadRead(
  workspaceId: string,
  mailboxId: string,
  threadId: string,
  read: boolean,
  token?: string,
): Promise<unknown> {
  return apiPut(`${mailBase(workspaceId, mailboxId)}/threads/${seg(threadId)}/read`, { read }, token);
}

export async function setThreadFlags(
  workspaceId: string,
  mailboxId: string,
  threadId: string,
  body: { flagged?: boolean; seen?: boolean },
  token?: string,
): Promise<{ thread_id: string; flagged?: boolean; seen?: boolean; updated: boolean }> {
  return apiPatch(`${mailBase(workspaceId, mailboxId)}/threads/${seg(threadId)}/flags`, body, token);
}

export async function emptyMailFolder(
  workspaceId: string,
  mailboxId: string,
  folder: 'trash' | 'spam',
  token?: string,
): Promise<{ folder: 'trash' | 'spam'; purged: number; updated: boolean }> {
  return apiPost(`${mailBase(workspaceId, mailboxId)}/folders/${folder}/empty`, { confirm: true }, token);
}

export async function createMailDraft(
  workspaceId: string,
  mailboxId: string,
  body: ComposeBody,
  token?: string,
): Promise<DraftSaveResponse> {
  return apiPost<DraftSaveResponse>(`${mailBase(workspaceId, mailboxId)}/drafts`, body, token);
}

export async function updateMailDraft(
  workspaceId: string,
  mailboxId: string,
  draftId: string,
  body: ComposeBody,
  token?: string,
): Promise<DraftSaveResponse> {
  return apiPut<DraftSaveResponse>(`${mailBase(workspaceId, mailboxId)}/drafts/${seg(draftId)}`, body, token);
}

export async function deleteMailDraft(
  workspaceId: string,
  mailboxId: string,
  draftId: string,
  token?: string,
): Promise<DraftSaveResponse> {
  return apiDelete<DraftSaveResponse>(`${mailBase(workspaceId, mailboxId)}/drafts/${seg(draftId)}`, token);
}

// ── Blobs (attachment download + cid inline images) ─────────────────────────

/** The API path for an attachment blob (relative to API_BASE). */
export function mailBlobPath(
  workspaceId: string,
  mailboxId: string,
  blobId: string,
  name?: string | null,
  type?: string | null,
): string {
  const params = new URLSearchParams();
  if (name) params.set('name', name);
  if (type) params.set('type', type);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return `${mailBase(workspaceId, mailboxId)}/blobs/${seg(blobId)}${qs}`;
}

/**
 * Fetch an attachment blob with the bearer token (an <img src>/<a href> can't
 * carry the Authorization header, so callers turn this into an object URL).
 */
export async function fetchMailBlob(
  workspaceId: string,
  mailboxId: string,
  blobId: string,
  name?: string | null,
  type?: string | null,
  token?: string,
): Promise<Blob> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${mailBlobPath(workspaceId, mailboxId, blobId, name, type)}`, {
    credentials: 'include',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, `Could not download the attachment (${res.status}).`);
  return res.blob();
}

/** The uploaded-blob echo from the attachments endpoint. */
export interface UploadedBlob {
  blob_id: string;
  name: string;
  type: string;
  size: number;
}

/**
 * Upload one file as a compose attachment (multipart field `file`), reporting
 * progress. Uses XHR because fetch has no upload-progress events.
 */
export function uploadMailAttachment(
  workspaceId: string,
  mailboxId: string,
  file: File,
  onProgress?: (fraction: number) => void,
  token?: string,
): Promise<UploadedBlob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${mailBase(workspaceId, mailboxId)}/attachments`);
    xhr.withCredentials = true; // send the HttpOnly session cookie (same-origin)
    const bearer = token ?? getToken();
    if (bearer) xhr.setRequestHeader('Authorization', `Bearer ${bearer}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedBlob);
        } catch {
          reject(new ApiError(xhr.status, 'Upload succeeded but the response was unreadable.'));
        }
      } else {
        let message = `Upload failed (${xhr.status}).`;
        try {
          const data = JSON.parse(xhr.responseText);
          if (typeof data?.message === 'string') message = data.message;
        } catch {
          /* non-JSON body */
        }
        reject(new ApiError(xhr.status, message));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed — network error.'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

// ── Bulk triage (Wave 2) ─────────────────────────────────────────────────────

export type BulkAction = 'archive' | 'trash' | 'spam' | 'inbox' | 'read' | 'unread';

export interface BulkActionResponse {
  /** Count or list of thread ids, depending on backend build — normalize before display. */
  succeeded: number | string[];
  failed: number | string[];
}

/** Normalize a bulk result field (count or id-list) to a count. */
export function bulkCount(v: number | string[] | undefined | null): number {
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return v.length;
  return 0;
}

/** Apply one action to many threads at once (Wave 2). 404/501 → hide bulk UI. */
export async function bulkThreadAction(
  workspaceId: string,
  threadIds: string[],
  action: BulkAction,
  token?: string,
): Promise<BulkActionResponse> {
  return apiPost<BulkActionResponse>(
    `/workspaces/${seg(workspaceId)}/mail/threads/bulk`,
    { thread_ids: threadIds, action },
    token,
  );
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

export async function getMailVacation(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<MailVacationSettings | null> {
  return apiGet<MailVacationSettings | null>(`${mailboxBase(workspaceId, mailboxId)}/vacation`, token);
}

export async function setMailVacation(
  workspaceId: string,
  mailboxId: string,
  body: {
    enabled: boolean;
    subject: string;
    body_html: string;
    starts_at?: string | null;
    ends_at?: string | null;
  },
  token?: string,
): Promise<MailVacationSettings> {
  return apiPut<MailVacationSettings>(`${mailboxBase(workspaceId, mailboxId)}/vacation`, body, token);
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

// ── Custom folders / labels (Wave 3) ─────────────────────────────────────────
//
// Only sovereign (stalwart) mailboxes have custom folders; external Gmail/M365
// accounts return []/false and creates come back 501. A 404/501 from the list
// route means the whole feature isn't deployed — callers feature-detect with
// `isMissingEndpoint` and hide the rail rather than erroring.

/**
 * One folder under a mailbox. `role` NON-null = a SYSTEM folder
 * (inbox/sent/archive/trash/junk/drafts, already shown as the hardcoded rail);
 * `role === null` = a CUSTOM folder (the ones this feature surfaces).
 */
export interface MailFolderView {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
  unread?: number;
}

export interface MailFoldersResponse {
  folders: MailFolderView[];
  count: number;
}

/** List every folder (system role + custom) under a mailbox — the rail + move menu. */
export async function listMailFolders(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<MailFoldersResponse> {
  return apiGet<MailFoldersResponse>(`${mailBase(workspaceId, mailboxId)}/folders`, token);
}

/**
 * Create a custom folder (optionally nested under `parentId`). Returns the new
 * folder's id. A 501 (`isMissingEndpoint`) means the engine is dormant or the
 * mailbox is external — the caller surfaces that as "can't create here", not a crash.
 */
export async function createMailFolder(
  workspaceId: string,
  mailboxId: string,
  name: string,
  parentId?: string | null,
  token?: string,
): Promise<{ id: string }> {
  return apiPost<{ id: string }>(
    `${mailBase(workspaceId, mailboxId)}/folders`,
    { name, parent_id: parentId ?? undefined },
    token,
  );
}

/** Rename a custom folder. `updated:false` = the engine could not apply it (surface it, don't fake success). */
export async function renameMailFolder(
  workspaceId: string,
  mailboxId: string,
  folderId: string,
  name: string,
  token?: string,
): Promise<{ updated: boolean }> {
  return apiPatch<{ updated: boolean }>(
    `${mailBase(workspaceId, mailboxId)}/folders/${seg(folderId)}`,
    { name },
    token,
  );
}

/**
 * Delete a CUSTOM folder. `deleted:false` = a system/role folder was refused
 * (they are inviolable), or the folder is unknown / external / dormant.
 */
export async function deleteMailFolder(
  workspaceId: string,
  mailboxId: string,
  folderId: string,
  token?: string,
): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(
    `${mailBase(workspaceId, mailboxId)}/folders/${seg(folderId)}`,
    token,
  );
}

/** Options for reading the threads inside a custom folder (same knobs as the mailbox list). */
export interface ListCustomFolderThreadsOpts {
  limit?: number;
  q?: string;
  offset?: number;
}

/**
 * The live threads INSIDE a custom folder, in the SAME `ThreadView` shape the
 * mailbox thread list renders — so selecting a folder just swaps the list source.
 */
export async function listCustomFolderThreads(
  workspaceId: string,
  mailboxId: string,
  folderId: string,
  opts: ListCustomFolderThreadsOpts = {},
  token?: string,
): Promise<MailThreadsResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 50));
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  if (opts.offset) params.set('offset', String(opts.offset));
  return apiGet<MailThreadsResponse>(
    `${mailBase(workspaceId, mailboxId)}/folders/${seg(folderId)}/threads?${params.toString()}`,
    token,
  );
}

/** Move a thread INTO a custom folder. `moved:false` = unknown target/thread, external, or dormant. */
export async function moveThreadToCustomFolder(
  workspaceId: string,
  mailboxId: string,
  threadId: string,
  folderId: string,
  token?: string,
): Promise<{ moved: boolean }> {
  return apiPut<{ moved: boolean }>(
    `${mailBase(workspaceId, mailboxId)}/threads/${seg(threadId)}/move`,
    { folder_id: folderId },
    token,
  );
}

// ── Snooze + send-later (Fleet A) — sovereign James mailboxes only ────────────

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

export interface ScheduledSendPayloadView {
  toAddress: string;
  subject: string;
  body: string;
  bodyHtml?: string | null;
}

export interface ScheduledSendView {
  id: string;
  mailbox_id: string;
  payload: ScheduledSendPayloadView;
  send_at: string;
  state: string;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
}

/**
 * Snooze a thread until `until` (ISO). `snoozed:false` = dormant/external/refused
 * — surface it, don't fake success. The engine hides the thread out of Inbox now
 * and the scheduler restores it at the chosen time.
 */
export async function snoozeThread(
  workspaceId: string,
  mailboxId: string,
  threadId: string,
  until: string,
  subject?: string | null,
  token?: string,
): Promise<{ snoozed: boolean; item: SnoozedThreadView | null }> {
  // Pass the subject the reader already has so the Snoozed view renders a human
  // row; the backend resolves it best-effort when a caller (e.g. an agent) omits it.
  const cleaned = subject?.trim();
  return apiPut<{ snoozed: boolean; item: SnoozedThreadView | null }>(
    `${mailBase(workspaceId, mailboxId)}/threads/${seg(threadId)}/snooze`,
    cleaned ? { until, subject: cleaned } : { until },
    token,
  );
}

/** Cancel an active snooze and restore the thread to Inbox. `unsnoozed:false` = nothing active/refused. */
export async function unsnoozeThread(
  workspaceId: string,
  mailboxId: string,
  threadId: string,
  token?: string,
): Promise<{ unsnoozed: boolean }> {
  return apiDelete<{ unsnoozed: boolean }>(
    `${mailBase(workspaceId, mailboxId)}/threads/${seg(threadId)}/snooze`,
    token,
  );
}

/** Active snoozed threads for one mailbox (empty when dormant/external). */
export async function listSnoozed(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<{ snoozed: SnoozedThreadView[]; count: number }> {
  return apiGet<{ snoozed: SnoozedThreadView[]; count: number }>(
    `${mailBase(workspaceId, mailboxId)}/snoozed`,
    token,
  );
}

export interface ScheduleSendBody {
  to_address: string;
  subject?: string;
  body?: string;
  body_html?: string;
  send_at: string;
  to_addresses?: string[];
  cc?: string[];
  bcc?: string[];
  attachments?: ComposeAttachmentRef[];
  in_reply_to_thread_id?: string;
  /** RFC-5322 threading passthrough (parity with the immediate-send lane). */
  in_reply_to?: string;
  references?: string[];
  /** The composer's autosaved draft — consumed (deleted) when the send fires,
   *  so a scheduled message doesn't strand an "already sent" draft in Drafts. */
  draft_id?: string;
}

/** Schedule an outbound email to leave at `send_at`. `scheduled:false` = dormant/external/refused. */
export async function scheduleSend(
  workspaceId: string,
  mailboxId: string,
  body: ScheduleSendBody,
  token?: string,
): Promise<{ scheduled: boolean; item: ScheduledSendView | null }> {
  return apiPost<{ scheduled: boolean; item: ScheduledSendView | null }>(
    `${mailBase(workspaceId, mailboxId)}/scheduled-sends`,
    body,
    token,
  );
}

/** Fetch ONE scheduled send in ANY state — the pending list hides sent/failed
 *  rows, so the undo-send bar polls this for a truthful verdict. Null item =
 *  missing/foreign/dormant. */
export async function getScheduledSend(
  workspaceId: string,
  mailboxId: string,
  id: string,
  token?: string,
): Promise<{ item: ScheduledSendView | null }> {
  return apiGet<{ item: ScheduledSendView | null }>(
    `${mailBase(workspaceId, mailboxId)}/scheduled-sends/${seg(id)}`,
    token,
  );
}

/** Cancel a pending scheduled send. `cancelled:false` = already sent/cancelled/unknown. */
export async function cancelScheduledSend(
  workspaceId: string,
  mailboxId: string,
  id: string,
  token?: string,
): Promise<{ cancelled: boolean }> {
  return apiDelete<{ cancelled: boolean }>(
    `${mailBase(workspaceId, mailboxId)}/scheduled-sends/${seg(id)}`,
    token,
  );
}

/** Pending scheduled sends for one mailbox (empty when dormant/external). */
export async function listScheduledSends(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<{ scheduled_sends: ScheduledSendView[]; count: number }> {
  return apiGet<{ scheduled_sends: ScheduledSendView[]; count: number }>(
    `${mailBase(workspaceId, mailboxId)}/scheduled-sends`,
    token,
  );
}
