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

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
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

export interface EmailOpsUser {
  id: string;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
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

/** Approve a pending draft (this SENDS it). */
export async function approveAgentInboxItem(
  workspaceId: string,
  itemId: string,
  note?: string,
  token?: string,
): Promise<ReviewResult> {
  return apiPost<ReviewResult>(
    `${inboxBase(workspaceId)}/${encodeURIComponent(itemId)}/approve`,
    note ? { note } : {},
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
  return apiPost<CleanupExecutionResponse>(
    `/connected-accounts/${encodeURIComponent(provider)}/cleanup/execute`,
    { plan, mode },
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
