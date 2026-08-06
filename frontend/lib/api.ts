/**
 * Minimal browser API client for Email-Ops (Phase 1).
 *
 * The auth model mirrors the suite pattern: the backend owns the Keycloak OIDC
 * dance and issues a local session JWT, which the browser stores in localStorage
 * and sends as a Bearer token. This is intentionally tiny — the Phase 2 mailbox
 * cockpit + the agent-inbox approval UI replace it with a typed data layer.
 */

export const API_BASE = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || '/api/v1';

const TOKEN_KEY = 'access_token';
const USER_KEY = 'user';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, user: unknown): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/**
 * Store just the signed-in user — for display AND as the client-side "logged in"
 * marker. The auth token itself now rides in an HttpOnly cookie (not readable by
 * JS), so the browser no longer holds the credential in localStorage. This marker
 * is non-sensitive (id/email/name) and only gates client-side routing.
 */
export function setStoredUser(user: unknown): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredUser<T = unknown>(): T | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Client-side "is there a session?" heuristic for routing gates. True when a
 * stored user marker exists OR a legacy localStorage token is present (transition
 * back-compat). The authoritative check is always the server — an API 401 makes
 * the guards bounce to login — this only avoids flashing the login screen to an
 * already-signed-in user whose session lives in the HttpOnly cookie.
 */
export function isAuthenticated(): boolean {
  if (typeof window === 'undefined') return false;
  return !!window.localStorage.getItem(USER_KEY) || !!window.localStorage.getItem(TOKEN_KEY);
}

/** Sign out server-side: clears the HttpOnly session cookie. Best-effort. */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    /* clear local state regardless of the network result */
  }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  void logout(); // also clear the server-side session cookie
}

/** The backend SSO entry point — redirects the browser to Keycloak. */
export function ssoLoginUrl(): string {
  return `${API_BASE}/auth/keycloak`;
}

/** An HTTP error that carries the status code so the UI can branch (401/403/404). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Best-effort extraction of a backend error message ({ message } | string). */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
    if (typeof data === 'string') return data;
  } catch {
    /* non-JSON body */
  }
  return fallback;
}

/** Authenticated GET against the backend. Throws ApiError on non-2xx. */
export async function apiGet<T = unknown>(path: string, token?: string): Promise<T> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res, `GET ${path} failed: ${res.status}`));
  }
  return (await res.json()) as T;
}

/** Authenticated POST against the backend. Throws ApiError on non-2xx. */
export async function apiPost<T = unknown>(
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res, `POST ${path} failed: ${res.status}`));
  }
  // Tolerate an empty 200/204 body.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export interface AssistantChatResult {
  ok: boolean;
  response: string;
}

/**
 * Send a turn to the Email-Ops assistant. `context` is a light digest of what
 * the operator is looking at (mailbox/folder/unread + a few thread subjects) so
 * the model can ground its reply — never message bodies.
 */
export async function assistantChat(
  message: string,
  context?: Record<string, unknown>,
  token?: string,
): Promise<AssistantChatResult> {
  return apiPost<AssistantChatResult>('/assistant/chat', { message, context: context ?? {} }, token);
}

/**
 * A confirm-before-anything action surfaced from a chat turn. The backend stages
 * the action into the agent-inbox and emits it shaped for the in-chat confirm
 * card. Two kinds: `draft` (reply/compose — carries `to`/`subject`/`preview`) and
 * `cleanup` (Trash/Archive a group of mail — carries `action`/`provider`/`count`/
 * `bytes`). Both carry `item_id` (the staged agent-inbox item to approve/reject).
 */
export interface AssistantAction {
  kind?: string;
  item_id?: string | null;
  to?: string | null;
  subject?: string | null;
  preview?: string | null;
  error?: string;
  // Cleanup-only fields (kind === 'cleanup'):
  /** Proposed verb: TRASH | ARCHIVE | DELETE. */
  action?: string;
  /** Connected provider the batch runs on: gmail | microsoft. */
  provider?: string | null;
  /** Messages the plan would affect. */
  count?: number;
  /** Storage the plan would free, in bytes. */
  bytes?: number;
  /** The agent's stated WHY for a cleanup (mirrors the inbox item's payload). */
  reason?: string | null;
  [key: string]: unknown;
}

export interface AssistantStreamHandlers {
  /** Called for each prose delta as it arrives — append to the live reply. */
  onToken: (delta: string) => void;
  /** Called once at the end with any proposed actions (may be empty). */
  onActions?: (actions: AssistantAction[]) => void;
  /** Called when the stream reports an error (before or during streaming). */
  onError?: () => void;
}

/** Parse one SSE frame (`event:` + `data:` lines) into a typed event. */
function parseSseFrame(frame: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Streaming assistant turn — the reply types out live, then any proposed actions
 * arrive. Workspace-scoped so the backend can resolve the acting user + workspace
 * (and, for actions, stage into that workspace's approval queue). `context` is the
 * same light digest as `assistantChat` — subjects/senders/snippets only.
 */
export async function assistantChatStream(
  workspaceId: string,
  message: string,
  context: Record<string, unknown> | undefined,
  handlers: AssistantStreamHandlers,
  token?: string,
): Promise<void> {
  const bearer = token ?? getToken();
  const res = await fetch(
    `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/assistant/chat/stream`,
    {
      credentials: 'include',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ message, context: context ?? {} }),
    },
  );
  if (!res.ok || !res.body) {
    handlers.onError?.();
    throw new ApiError(res.status, `chat stream failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawError = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const evt = parseSseFrame(frame);
      if (!evt) continue;
      if (evt.event === 'token') {
        const delta = typeof evt.data.delta === 'string' ? evt.data.delta : '';
        if (delta) handlers.onToken(delta);
      } else if (evt.event === 'actions') {
        const actions = Array.isArray(evt.data.actions)
          ? (evt.data.actions as AssistantAction[])
          : [];
        handlers.onActions?.(actions);
      } else if (evt.event === 'error') {
        sawError = true;
      }
    }
  }
  if (sawError) handlers.onError?.();
}

/** Authenticated PATCH against the backend. Throws ApiError on non-2xx. */
export async function apiPatch<T = unknown>(
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res, `PATCH ${path} failed: ${res.status}`));
  }
  // Tolerate an empty 200/204 body.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Authenticated PUT against the backend. Throws ApiError on non-2xx. */
export async function apiPut<T = unknown>(path: string, body?: unknown, token?: string): Promise<T> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res, `PUT ${path} failed: ${res.status}`));
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Authenticated DELETE against the backend. Throws ApiError on non-2xx. */
export async function apiDelete<T = unknown>(path: string, token?: string): Promise<T> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    method: 'DELETE',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res, `DELETE ${path} failed: ${res.status}`));
  }
  // Tolerate an empty 200/204 body.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export interface EmailOpsUser {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  /** Avatar URL from the Keycloak `picture` claim (suite avatar spine). */
  picture?: string | null;
}

export async function fetchProfile(token?: string): Promise<EmailOpsUser> {
  return apiGet<EmailOpsUser>('/auth/profile', token);
}

export interface MyWorkspace {
  workspace_id: string;
  slug: string;
  display_name: string;
  role: string;
  is_default: boolean;
}

/** Fetch the workspaces the signed-in user is an active member of. */
export async function fetchMyWorkspaces(token?: string): Promise<MyWorkspace[]> {
  const data = await apiGet<{ workspaces: MyWorkspace[] }>('/auth/me/workspaces', token);
  return data.workspaces ?? [];
}

// ── Agent-inbox (Phase 2) ─────────────────────────────────────────────────

export type AgentInboxState = 'pending' | 'approved' | 'rejected';

/** One agent-inbox item (mirrors the backend AgentInboxView wire shape). */
export interface AgentInboxItemView {
  id: string;
  message_id: string | null;
  kind?: string;
  state: AgentInboxState;
  drafted_by: string | null;
  summary: string | null;
  to_address: string | null;
  subject: string | null;
  body_preview: string | null;
  reviewed_by_uc_uid: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string | null;
  payload?: Record<string, unknown> | null;
}

/** The compose/message projection echoed back on approve/reject. */
export interface MessageView {
  id: string;
  thread_id: string | null;
  status: string;
  mode: string;
  external_source: string | null;
  external_ref: string | null;
  created_at: string | null;
}

export interface AgentInboxListResponse {
  items: AgentInboxItemView[];
  count: number;
}

export interface ReviewResult {
  inbox: AgentInboxItemView;
  message: MessageView | null;
}

const inboxBase = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/agent-inbox`;

/** List the agent-inbox queue for a workspace (defaults to pending). */
export async function listAgentInbox(
  workspaceId: string,
  state?: AgentInboxState,
  token?: string,
): Promise<AgentInboxListResponse> {
  const qs = state ? `?state=${encodeURIComponent(state)}` : '';
  return apiGet<AgentInboxListResponse>(`${inboxBase(workspaceId)}${qs}`, token);
}

/** Optional knobs on an approve (Wave 7). */
export interface ApproveOptions {
  /**
   * Whether approving should also TRUST the external recipient(s) so future
   * agent replies to them can auto-send under policy. The server defaults to
   * true; the UI sends an explicit value only when it surfaced the choice.
   */
  trustRecipients?: boolean;
}

/** Approve a pending draft (this SENDS it). */
export async function approveAgentInboxItem(
  workspaceId: string,
  itemId: string,
  note?: string,
  opts?: ApproveOptions,
  token?: string,
): Promise<ReviewResult> {
  return apiPost<ReviewResult>(
    `${inboxBase(workspaceId)}/${encodeURIComponent(itemId)}/approve`,
    {
      ...(note ? { note } : {}),
      ...(opts?.trustRecipients !== undefined ? { trustRecipients: opts.trustRecipients } : {}),
    },
    token,
  );
}

/** Reject a pending draft (it is never sent). */
export async function rejectAgentInboxItem(
  workspaceId: string,
  itemId: string,
  note?: string,
  token?: string,
): Promise<ReviewResult> {
  return apiPost<ReviewResult>(
    `${inboxBase(workspaceId)}/${encodeURIComponent(itemId)}/reject`,
    note ? { note } : {},
    token,
  );
}

// ── Agent-inbox full-fidelity review (Wave 7) ─────────────────────────────
//
// The approval queue's review panel shows THE FULL staged email — rendered
// body, every recipient, attachments — before a human approves. The wire
// shapes here tolerate both snake_case (house style) and camelCase (the
// staging payloads) key spellings, normalizing to snake_case for the UI.
// Endpoints ship with the Wave-7 backend; every fetcher lives behind a small
// helper so a path is one-line adjustable, and callers feature-detect with
// 404/501 (absent = degrade, never crash).

/** One machine-readable WHY on a held draft (payload.policy.reasons[]). */
export interface HoldReasonView {
  code: string;
  message: string;
}

/** The send-policy verdict stamped on a staged draft (payload.policy). */
export interface HoldPolicyView {
  decision: string;
  reasons: HoldReasonView[];
}

/** One attachment on a staged (not yet sent) message. Meta only; `blob_id` when downloadable. */
export interface StagedAttachmentView {
  name: string | null;
  type: string | null;
  size: number | null;
  blob_id: string | null;
  cid: string | null;
}

/**
 * The FULL staged message behind an agent-inbox EMAIL item (or an auto-sent
 * audit row) — everything the review panel renders: subject, sender, all
 * recipients, both bodies, attachment meta, and the thread it belongs to.
 */
export interface StagedMessageView {
  subject: string | null;
  from_address: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  html_body: string | null;
  text_body: string | null;
  attachments: StagedAttachmentView[];
  thread_id: string | null;
  /** The mailbox the draft sends from, when the wire exposes it — routes blob fetches. */
  mailbox_id: string | null;
}

function asRec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

function asNum(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** "jane@acme.com" | { address, name? } | mixed array → normalized address list. */
function asAddressList(value: unknown): string[] {
  const one = (v: unknown): string | null => {
    const s = asStr(v);
    if (s) return s;
    const rec = asRec(v);
    if (rec) {
      const addr = asStr(rec.address) ?? asStr(rec.email);
      if (!addr) return null;
      const name = asStr(rec.name);
      return name ? `${name} <${addr}>` : addr;
    }
    return null;
  };
  const arr = Array.isArray(value) ? value : value != null ? [value] : [];
  const out: string[] = [];
  for (const v of arr) {
    const s = one(v);
    // A comma-joined to_address string is still one wire value — split it.
    if (s) {
      for (const part of s.includes(',') && !s.includes('<') ? s.split(',') : [s]) {
        const t = part.trim();
        if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
      }
    }
  }
  return out;
}

function coerceStagedAttachment(raw: unknown): StagedAttachmentView | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const name = asStr(rec.name) ?? asStr(rec.filename);
  const type = asStr(rec.type) ?? asStr(rec.content_type) ?? asStr(rec.contentType);
  if (!name && !type) return null;
  return {
    name,
    type,
    size: asNum(rec.size),
    blob_id: asStr(rec.blob_id) ?? asStr(rec.blobId),
    cid: asStr(rec.cid),
  };
}

/**
 * Normalize a full-fidelity staged-message wire object (either key spelling)
 * to the UI shape. Returns null when the object carries nothing renderable —
 * callers then fall back to the queue item's summary fields.
 */
export function coerceStagedMessage(raw: unknown): StagedMessageView | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const to = asAddressList(
    rec.to_addresses ?? rec.toAddresses ?? rec.to_address ?? rec.toAddress ?? rec.to,
  );
  const cc = asAddressList(rec.cc_addresses ?? rec.ccAddresses ?? rec.cc);
  const fromRaw =
    rec.from_address ?? rec.fromAddress ?? rec.from ?? rec.from_mailbox_address ?? null;
  const from = asAddressList(fromRaw)[0] ?? null;
  const html = asStr(rec.html_body) ?? asStr(rec.htmlBody) ?? asStr(rec.body_html) ?? asStr(rec.bodyHtml);
  const text = asStr(rec.text_body) ?? asStr(rec.textBody) ?? asStr(rec.body);
  const subject = asStr(rec.subject);
  const attachments = (Array.isArray(rec.attachments) ? rec.attachments : [])
    .map(coerceStagedAttachment)
    .filter((a): a is StagedAttachmentView => a !== null);
  // Nothing renderable → not a staged message (guards against coercing e.g. a bare {}).
  if (!subject && !from && to.length === 0 && !html && !text && attachments.length === 0) {
    return null;
  }
  return {
    subject,
    from_address: from,
    to_addresses: to,
    cc_addresses: cc,
    html_body: html,
    text_body: text,
    attachments,
    thread_id: asStr(rec.thread_id) ?? asStr(rec.threadId),
    mailbox_id:
      asStr(rec.mailbox_id) ??
      asStr(rec.mailboxId) ??
      asStr(rec.from_mailbox_id) ??
      asStr(rec.fromMailboxId) ??
      asStr(rec.mailbox_account_id) ??
      asStr(rec.mailboxAccountId),
  };
}

/** Read the send-policy verdict off an item/detail payload (tolerant; null when absent). */
export function holdPolicyOf(payload: unknown): HoldPolicyView | null {
  const rec = asRec(payload);
  const policy = rec ? asRec(rec.policy) : null;
  if (!policy) return null;
  const reasonsRaw = Array.isArray(policy.reasons) ? policy.reasons : [];
  const reasons: HoldReasonView[] = [];
  for (const r of reasonsRaw) {
    const s = asStr(r);
    if (s) {
      reasons.push({ code: 'hold', message: s });
      continue;
    }
    const rr = asRec(r);
    if (!rr) continue;
    const message = asStr(rr.message) ?? asStr(rr.detail);
    if (message) reasons.push({ code: asStr(rr.code) ?? 'hold', message });
  }
  return { decision: asStr(policy.decision) ?? 'hold', reasons };
}

/** The detail read for one agent-inbox item: the item + its FULL staged message. */
export interface AgentInboxItemDetail {
  item: AgentInboxItemView | null;
  message: StagedMessageView | null;
}

/**
 * Fetch the full-fidelity detail for one agent-inbox item. Tolerates the
 * response arriving as `{ item, message }`, `{ inbox, message }`, or a flat
 * item-with-message object. 404 from a pre-Wave-7 backend → the caller keeps
 * the degraded (list-shaped) view.
 */
export async function getAgentInboxItemDetail(
  workspaceId: string,
  itemId: string,
  token?: string,
): Promise<AgentInboxItemDetail> {
  const raw = await apiGet<Record<string, unknown>>(
    `${inboxBase(workspaceId)}/${encodeURIComponent(itemId)}`,
    token,
  );
  const itemRaw = asRec(raw.item) ?? asRec(raw.inbox) ?? asRec(raw);
  const item =
    itemRaw && typeof itemRaw.id === 'string' && typeof itemRaw.state === 'string'
      ? (itemRaw as unknown as AgentInboxItemView)
      : null;
  const message =
    coerceStagedMessage(raw.message) ??
    coerceStagedMessage(itemRaw?.message) ??
    coerceStagedMessage(asRec(itemRaw?.payload)?.message) ??
    coerceStagedMessage(raw) ??
    null;
  return { item, message };
}

// ── Auto-sent audit lane (Wave 7) ─────────────────────────────────────────

/** One policy-auto-sent email (no human approved it) — the after-the-fact audit row. */
export interface AutoSentItemView {
  id: string;
  agent_key: string | null;
  created_at: string | null;
  detail: string | null;
  message: StagedMessageView | null;
}

export interface AutoSentListResponse {
  items: AutoSentItemView[];
}

/**
 * List the workspace's policy-auto-sent agent mail, newest-first. 404/501 →
 * the lane isn't deployed yet; callers show the "not available" state.
 */
export async function listAutoSent(
  workspaceId: string,
  token?: string,
): Promise<AutoSentListResponse> {
  const raw = await apiGet<{ items?: unknown[] }>(`${inboxBase(workspaceId)}/auto-sent`, token);
  const items: AutoSentItemView[] = (Array.isArray(raw.items) ? raw.items : [])
    .map((it) => {
      const rec = asRec(it);
      if (!rec) return null;
      const id = asStr(rec.id);
      if (!id) return null;
      return {
        id,
        agent_key: asStr(rec.agent_key) ?? asStr(rec.agentKey),
        created_at: asStr(rec.created_at) ?? asStr(rec.createdAt),
        detail: asStr(rec.detail),
        message: coerceStagedMessage(rec.message),
      };
    })
    .filter((it): it is AutoSentItemView => it !== null);
  return { items };
}

// ── Trusted correspondents (Wave 7) ───────────────────────────────────────

/** How an address earned trust: added by hand, or via an approval's trust checkbox. */
export type TrustedCorrespondentSource = 'MANUAL' | 'APPROVAL';

/** ADDRESS = one address; DOMAIN = every address at a bare domain (Wave 10). */
export type TrustedCorrespondentScope = 'ADDRESS' | 'DOMAIN';

/** One trusted external correspondent (agents may auto-reply to them under policy). */
export interface TrustedCorrespondentView {
  id: string;
  address: string;
  scope: TrustedCorrespondentScope;
  source: TrustedCorrespondentSource;
  approval_count: number;
  last_approved_at: string | null;
  added_by_uc_uid: string | null;
  note: string | null;
  created_at: string | null;
}

export interface TrustedCorrespondentsResponse {
  items: TrustedCorrespondentView[];
}

const trustedBase = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/trusted-correspondents`;

function coerceTrustedCorrespondent(raw: unknown): TrustedCorrespondentView | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const id = asStr(rec.id);
  const address = asStr(rec.address);
  if (!id || !address) return null;
  const source = asStr(rec.source)?.toUpperCase() === 'MANUAL' ? 'MANUAL' : 'APPROVAL';
  const scope = asStr(rec.scope)?.toUpperCase() === 'DOMAIN' ? 'DOMAIN' : 'ADDRESS';
  return {
    id,
    address,
    scope,
    source,
    approval_count: asNum(rec.approval_count ?? rec.approvalCount) ?? 0,
    last_approved_at: asStr(rec.last_approved_at) ?? asStr(rec.lastApprovedAt),
    added_by_uc_uid: asStr(rec.added_by_uc_uid) ?? asStr(rec.addedByUcUid),
    note: asStr(rec.note),
    created_at: asStr(rec.created_at) ?? asStr(rec.createdAt),
  };
}

/** List the workspace's trusted correspondents. 404/501 → feature not deployed. */
export async function listTrustedCorrespondents(
  workspaceId: string,
  token?: string,
): Promise<TrustedCorrespondentsResponse> {
  const raw = await apiGet<{ items?: unknown[] }>(trustedBase(workspaceId), token);
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(coerceTrustedCorrespondent)
    .filter((it): it is TrustedCorrespondentView => it !== null);
  return { items };
}

/**
 * Trust an address OR a whole domain by hand (agents may then auto-reply under
 * policy). `scope` is inferred server-side from the value when omitted — pass a
 * bare domain (acme.com) to trust everyone at it.
 */
export async function addTrustedCorrespondent(
  workspaceId: string,
  address: string,
  note?: string,
  token?: string,
  scope?: 'address' | 'domain',
): Promise<TrustedCorrespondentView | null> {
  const raw = await apiPost<Record<string, unknown>>(
    trustedBase(workspaceId),
    { address, ...(note ? { note } : {}), ...(scope ? { scope } : {}) },
    token,
  );
  return coerceTrustedCorrespondent(asRec(raw.item) ?? raw);
}

/** Revoke trust for a correspondent by row id (future agent replies to them hold for approval). */
export async function removeTrustedCorrespondent(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<{ removed: boolean }> {
  await apiDelete(`${trustedBase(workspaceId)}/${encodeURIComponent(id)}`, token);
  return { removed: true };
}

// ── Agent registry (Phase 6) ──────────────────────────────────────────────

/** How much an agent is trusted to act on its own in the send path. */
export type AutonomyLevel = 'L0_DRAFT_ONLY' | 'L1_APPROVE_TO_SEND' | 'L2_AUTONOMOUS_AUDIT';

/** Where an agent sits in the fleet hierarchy (UNSPECIFIED = not yet placed). */
export type AgentTier =
  | 'EXECUTIVE'
  | 'DOMAIN_LEAD'
  | 'MANAGER'
  | 'SPECIALIST'
  | 'UNSPECIFIED';

/** What an agent may do with a bound mailbox. */
export type MailboxAccess = 'SEND' | 'READ' | 'BOTH';

/** One mailbox bound to an agent (mirrors the backend AgentMailboxView). */
export interface AgentMailboxView {
  mailbox_account_id: string;
  mailbox_address: string | null;
  access: MailboxAccess;
  is_primary: boolean;
}

/** One fleet agent (mirrors the backend AgentView wire shape; snake_case). */
export interface AgentView {
  id: string;
  key: string; // stable slug, unique per workspace, e.g. "customer-ops"
  display_name: string;
  description: string | null;
  /** Explicit avatar URL when set; renderers fall back to /agent-avatars/<key>.svg → default.svg. */
  avatar_url?: string | null;
  mailbox_account_id: string | null;
  mailbox_address: string | null; // resolved email address of the mailbox, for display
  autonomy_level: AutonomyLevel;
  recipient_policy: Record<string, unknown> | null;
  active: boolean;
  pending_count: number; // how many of this agent's drafts await approval
  /** Every mailbox this agent can act on (one is_primary; may include the legacy single mailbox). */
  mailboxes: AgentMailboxView[];
  /** Where this agent sits in the org hierarchy. */
  tier: AgentTier;
  /** The key of the agent this one reports to (null = top of its branch). */
  manager_agent_key: string | null;
  /** Whether this agent is individually paused (distinct from the workspace kill switch). */
  paused: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateAgentBody {
  key: string;
  display_name: string;
  description?: string;
  mailbox_account_id?: string;
  autonomy_level?: AutonomyLevel;
  recipient_policy?: Record<string, unknown>;
}

export interface UpdateAgentBody {
  display_name?: string;
  description?: string | null;
  avatar_url?: string | null;
  mailbox_account_id?: string | null;
  autonomy_level?: AutonomyLevel;
  recipient_policy?: Record<string, unknown> | null;
  active?: boolean;
}

export interface AgentListResponse {
  items: AgentView[];
  count: number;
}

const agentsBase = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/agents`;

/** List the agent fleet for a workspace. */
export async function listAgents(
  workspaceId: string,
  token?: string,
): Promise<AgentListResponse> {
  return apiGet<AgentListResponse>(agentsBase(workspaceId), token);
}

/** Create a new agent (409 on duplicate key, 400 if mailbox not in workspace). */
export async function createAgent(
  workspaceId: string,
  body: CreateAgentBody,
  token?: string,
): Promise<AgentView> {
  return apiPost<AgentView>(agentsBase(workspaceId), body, token);
}

/** Fetch a single agent by id (404 if missing). */
export async function getAgent(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<AgentView> {
  return apiGet<AgentView>(`${agentsBase(workspaceId)}/${encodeURIComponent(id)}`, token);
}

/** Update an agent's mailbox / autonomy / active flag (404 if missing). */
export async function updateAgent(
  workspaceId: string,
  id: string,
  body: UpdateAgentBody,
  token?: string,
): Promise<AgentView> {
  return apiPatch<AgentView>(`${agentsBase(workspaceId)}/${encodeURIComponent(id)}`, body, token);
}

// ── Per-agent mailbox view (Fleet B) — see into each agent's own inbox ────────

/** A thread row in an agent's mailbox (subset of the mail ThreadView wire shape). */
export interface AgentMailboxThread {
  id: string;
  subject: string | null;
  unread: boolean;
  last_message_at: string | null;
  last_snippet: string | null;
  participants: { address: string; name: string | null }[];
}

export interface AgentMailboxAgentSummary {
  id: string;
  name: string;
  handle: string;
  avatarUrl?: string;
  mailbox: { id: string; address: string; provider: string } | null;
}

export interface AgentMailboxStats {
  unread?: number;
  total?: number;
  lastActivityAt?: string | null;
}

/** The composed "agent mailbox world": mailbox + recent threads + approval queue + stats. */
export interface AgentMailboxViewResponse {
  agent: AgentMailboxAgentSummary;
  threads: AgentMailboxThread[];
  agentInbox: {
    pending: AgentInboxItemView[];
    counts: { pending: number; approved: number; rejected: number };
  };
  stats: AgentMailboxStats;
}

export interface AgentMailboxRosterItem {
  agent: AgentMailboxAgentSummary;
  mailbox: { address: string | null; unread: number; pending: number };
}

export interface AgentMailboxRosterResponse {
  items: AgentMailboxRosterItem[];
  count: number;
}

/** Lightweight per-agent mailbox roster (address + unread + pending) for the fleet. */
export async function listAgentMailboxes(
  workspaceId: string,
  token?: string,
): Promise<AgentMailboxRosterResponse> {
  return apiGet<AgentMailboxRosterResponse>(`${agentsBase(workspaceId)}/mailboxes`, token);
}

/** One agent's mailbox world: recent threads, pending approvals, and stats (404 if missing). */
export async function getAgentMailbox(
  workspaceId: string,
  agentId: string,
  threadLimit?: number,
  token?: string,
): Promise<AgentMailboxViewResponse> {
  const q = threadLimit ? `?thread_limit=${encodeURIComponent(threadLimit)}` : '';
  return apiGet<AgentMailboxViewResponse>(
    `${agentsBase(workspaceId)}/${encodeURIComponent(agentId)}/mailbox${q}`,
    token,
  );
}

/** One workspace mailbox (mirrors the backend mailbox list wire shape). */
export interface MailboxListItem {
  id: string;
  email_address: string;
  display_name: string | null;
  owner_kind: string;
  kind: string;
}

export interface MailboxListResponse {
  items: MailboxListItem[];
  count: number;
}

/** List the workspace's mailboxes — feeds the agent mailbox-binding picker. */
export async function listMailboxes(
  workspaceId: string,
  token?: string,
): Promise<MailboxListResponse> {
  return apiGet<MailboxListResponse>(
    '/workspaces/' + encodeURIComponent(workspaceId) + '/mailboxes',
    token,
  );
}

/** Body for binding (or re-binding) a mailbox to an agent. */
export interface BindAgentMailboxBody {
  mailbox_account_id: string;
  access?: MailboxAccess;
  is_primary?: boolean;
}

/**
 * Bind a mailbox to an agent (ADMIN-gated → 403 on policy denial). Re-binding an
 * already-bound mailbox updates its access / primary flag. Returns the refreshed agent.
 */
export async function bindAgentMailbox(
  workspaceId: string,
  agentId: string,
  body: BindAgentMailboxBody,
  token?: string,
): Promise<AgentView> {
  return apiPost<AgentView>(
    '/workspaces/' +
      encodeURIComponent(workspaceId) +
      '/agents/' +
      encodeURIComponent(agentId) +
      '/mailboxes',
    body,
    token,
  );
}

/** Unbind a mailbox from an agent (ADMIN-gated → 403). Returns the refreshed agent. */
export async function unbindAgentMailbox(
  workspaceId: string,
  agentId: string,
  mailboxId: string,
  token?: string,
): Promise<AgentView> {
  return apiDelete<AgentView>(
    '/workspaces/' +
      encodeURIComponent(workspaceId) +
      '/agents/' +
      encodeURIComponent(agentId) +
      '/mailboxes/' +
      encodeURIComponent(mailboxId),
    token,
  );
}

// ── Email health (Phase 6) ────────────────────────────────────────────────

/** Severity of a single health signal (and the rollup it feeds). */
export type HealthLevel = 'ok' | 'warn' | 'fail';

/** One health signal (mirrors the backend EmailHealthCheck wire shape). */
export interface EmailHealthCheck {
  key: string;
  label: string;
  status: HealthLevel;
  detail: string;
}

/** The "is email healthy?" snapshot for a workspace (mirrors EmailHealthReport). */
export interface EmailHealthReport {
  /** Rollup: degraded if any check fails, attention if any warns, else ok. */
  status: 'ok' | 'attention' | 'degraded';
  checks: EmailHealthCheck[];
  setup: {
    engine_configured: boolean;
    default_mailbox: string | null;
    mailbox_count: number;
    agent_count: number; // active registered agents
    autonomous_agents: number; // active L2 agents (can send without approval)
  };
  queue: {
    pending_approvals: number;
    oldest_pending_age_hours: number | null;
    failed_sends_7d: number;
  };
  generated_at: string; // ISO
}

/** Fetch the email-health snapshot for a workspace (JWT + membership guarded). */
export async function getEmailHealth(
  workspaceId: string,
  token?: string,
): Promise<EmailHealthReport> {
  return apiGet<EmailHealthReport>(
    '/workspaces/' + encodeURIComponent(workspaceId) + '/email-health',
    token,
  );
}

// -- Connected accounts cleaner cockpit ------------------------------------

export type ConnectedProvider = 'gmail' | 'microsoft';

export interface LinkedAccountView {
  provider: ConnectedProvider;
  linked: boolean;
}

export interface ConnectedAccountsListResponse {
  accounts: LinkedAccountView[];
}

export interface EngineInboxStats {
  total_messages: number;
  total_threads: number;
  unread_count: number;
  promotional_count: number;
  social_count: number;
  storage_used_bytes: number;
  storage_limit_bytes?: number;
  [key: string]: unknown;
}

export type ConnectedAccountsStatsResponse =
  | {
      available: false;
      provider: ConnectedProvider;
      reason: string;
    }
  | {
      available: true;
      provider: ConnectedProvider;
      stats: EngineInboxStats;
    };

export type ConnectedAccountsAnalysisResponse =
  | {
      available: false;
      provider: ConnectedProvider;
      reason: string;
    }
  | {
      available: true;
      provider: ConnectedProvider;
      analysis: Record<string, unknown>;
    };

export interface CleanupPlanMessageView {
  id: string;
  sender: string | null;
  subject: string | null;
  date: string | null;
  size_bytes: number;
  starred: boolean;
  labels: string[];
  protected: boolean;
  reason: string | null;
}

export interface CleanupPlanResponse {
  provider: ConnectedProvider;
  criteria: Record<string, unknown>;
  counts: {
    reviewed: number;
    safe: number;
    protected: number;
  };
  freesBytes: number;
  protected: CleanupPlanMessageView[];
  safe: CleanupPlanMessageView[];
  backup_query: string;
}

export interface CleanupExecutionResponse {
  ok: boolean;
  provider: ConnectedProvider;
  mode: 'trash' | 'delete' | 'archive_purge' | 'archive' | 'unsubscribe' | 'undo';
  batch_id: string;
  action: string;
  plan: CleanupPlanResponse;
  result: {
    completed: number;
    failed: number;
    bytes_freed: number;
    total_attempted: number;
  };
  backup_ref?: {
    path: string;
    verified: boolean;
    created_at: string | null;
    total_messages: number;
    bucket?: string;
    key?: string;
    bytes?: number;
    sha256?: string;
    expires_at?: string | null;
    retained?: boolean;
    download_url?: string | null;
  } | null;
  status: 'completed' | 'pending' | 'rejected' | 'failed' | 'undone';
  staged?: boolean;
  staged_item_id?: string | null;
  reason?: string | null;
}

export interface CleanupBatchView {
  id: string;
  provider: ConnectedProvider;
  action: string;
  mode: string;
  state: string;
  summary: string;
  params: string;
  result: string;
  backup_ref: string | null;
  archive_bucket?: string | null;
  archive_key?: string | null;
  archive_bytes?: number | null;
  archive_sha256?: string | null;
  archive_expires_at?: string | null;
  archive_retained?: boolean;
  restored_at?: string | null;
  undoable: boolean;
  created_at: string;
  updated_at: string;
}

export async function listConnectedAccounts(
  token?: string,
): Promise<ConnectedAccountsListResponse> {
  return apiGet<ConnectedAccountsListResponse>('/connected-accounts', token);
}

/**
 * Mint an in-app Keycloak account-link URL for a provider. The browser then
 * navigates there (carrying its KC SSO session) to link Google/Microsoft to the
 * signed-in identity, returning to /accounts?linked=<provider>.
 */
export async function getProviderLinkUrl(
  provider: ConnectedProvider,
  token?: string,
): Promise<{ url: string }> {
  return apiGet<{ url: string }>(
    `/connected-accounts/${encodeURIComponent(provider)}/link-url`,
    token,
  );
}

export async function getInboxStats(
  provider: ConnectedProvider,
  token?: string,
): Promise<ConnectedAccountsStatsResponse> {
  return apiGet<ConnectedAccountsStatsResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/stats`,
    token,
  );
}

export async function analyzeInbox(
  provider: ConnectedProvider,
  token?: string,
): Promise<ConnectedAccountsAnalysisResponse> {
  return apiPost<ConnectedAccountsAnalysisResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/analyze`,
    {},
    token,
  );
}

export async function planCleanup(
  provider: ConnectedProvider,
  criteria: Record<string, unknown>,
  token?: string,
): Promise<CleanupPlanResponse> {
  return apiPost<CleanupPlanResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/cleanup/plan`,
    { criteria },
    token,
  );
}

export async function executeCleanup(
  provider: ConnectedProvider,
  plan: CleanupPlanResponse,
  mode: 'trash' | 'delete' | 'archive_purge',
  token?: string,
): Promise<CleanupExecutionResponse> {
  // The server re-plans from `criteria` and only needs the SELECTED message ids.
  // Sending the full message rows (hundreds of subjects/senders) overflows the
  // JSON body limit → 413 → "trash doesn't work". Send a slim plan: ids only.
  const slimPlan = {
    criteria: plan.criteria,
    safe: plan.safe.map((row) => ({ id: row.id })),
    protected: [] as { id: string }[],
    counts: plan.counts,
  };
  return apiPost<CleanupExecutionResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/cleanup/execute`,
    { plan: slimPlan, mode },
    token,
  );
}

export async function organizeMessages(
  provider: ConnectedProvider,
  criteria: Record<string, unknown>,
  token?: string,
): Promise<CleanupExecutionResponse> {
  return apiPost<CleanupExecutionResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/organize`,
    { criteria },
    token,
  );
}

export async function unsubscribeSender(
  provider: ConnectedProvider,
  senderGroup: string[],
  token?: string,
): Promise<CleanupExecutionResponse> {
  return apiPost<CleanupExecutionResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/unsubscribe`,
    { senderGroup },
    token,
  );
}

export async function undoBatch(
  provider: ConnectedProvider,
  batchId: string,
  token?: string,
): Promise<CleanupExecutionResponse> {
  return apiPost<CleanupExecutionResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/undo`,
    { batchId },
    token,
  );
}

export async function restoreCleanupBatch(
  provider: ConnectedProvider,
  batchId: string,
  token?: string,
): Promise<CleanupExecutionResponse> {
  return apiPost<CleanupExecutionResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/cleanup/${encodeURIComponent(batchId)}/restore`,
    {},
    token,
  );
}

export async function archiveDownloadUrl(
  provider: ConnectedProvider,
  batchId: string,
  token?: string,
): Promise<{ url: string; expires_in_seconds: number }> {
  return apiGet<{ url: string; expires_in_seconds: number }>(
    `/connected-accounts/${encodeURIComponent(provider)}/cleanup/${encodeURIComponent(batchId)}/archive-download`,
    token,
  );
}

export async function cleanupActivity(
  provider: ConnectedProvider,
  token?: string,
): Promise<{ items: CleanupBatchView[] }> {
  return apiGet<{ items: CleanupBatchView[] }>(
    `/connected-accounts/${encodeURIComponent(provider)}/cleanup/activity`,
    token,
  );
}

// ── Agent controls (kill switch) + activity feed ──────────────────────────

export interface AgentControls {
  agents_paused: boolean;
}

/** Read the workspace kill switch (are agents paused?). */
export async function getAgentControls(workspaceId: string, token?: string): Promise<AgentControls> {
  return apiGet<AgentControls>(
    `/workspaces/${encodeURIComponent(workspaceId)}/agent-controls`,
    token,
  );
}

/** Set the workspace kill switch — pause/resume all agents. */
export async function setAgentControls(
  workspaceId: string,
  agentsPaused: boolean,
  token?: string,
): Promise<AgentControls> {
  return apiPut<AgentControls>(
    `/workspaces/${encodeURIComponent(workspaceId)}/agent-controls`,
    { agents_paused: agentsPaused },
    token,
  );
}

export type AgentActionKind =
  | 'AUTONOMOUS_SEND'
  | 'STAGED_FOR_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'PAUSED'
  | 'RESUMED';

/** One agent-mail activity/audit row (mirrors the backend AgentActivityView). */
export interface AgentActivityView {
  id: string;
  kind: AgentActionKind;
  agent_key: string | null;
  message_id: string | null;
  actor_uc_uid: string | null;
  detail: string | null;
  created_at: string | null;
}

export interface AgentActivityResponse {
  items: AgentActivityView[];
  count: number;
}

/** Recent agent-mail activity (the audit feed), newest-first. */
export async function getAgentActivity(
  workspaceId: string,
  limit?: number,
  token?: string,
): Promise<AgentActivityResponse> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return apiGet<AgentActivityResponse>(
    `/workspaces/${encodeURIComponent(workspaceId)}/agent-activity${qs}`,
    token,
  );
}

/**
 * Real server-side rail metrics (mirrors the backend AgentMetricsView).
 *   triaged  — distinct threads an AGENT filed in the window.
 *   sent     — agent autonomous + approved-then-sent sends in the window.
 *   awaiting — CURRENT pending approvals (not windowed; = the nav badge).
 * Honest server counts — NOT the old client-side activity-volume proxy.
 */
export interface AgentMetrics {
  triaged: number;
  sent: number;
  awaiting: number;
  window_days: number;
}

/**
 * Fetch the workspace's agent-metrics. `window` is a lookback like "7d" / "30d"
 * (the backend clamps to 1–90d and is degrade-clean: zeros on no data).
 */
export async function getAgentMetrics(
  workspaceId: string,
  window?: string,
  token?: string,
): Promise<AgentMetrics> {
  const qs = window ? `?window=${encodeURIComponent(window)}` : '';
  return apiGet<AgentMetrics>(
    `/workspaces/${encodeURIComponent(workspaceId)}/agent-metrics${qs}`,
    token,
  );
}
