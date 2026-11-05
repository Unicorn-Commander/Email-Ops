/**
 * Typed browser client for the workspace suppression list.
 *
 * Thin layer over `/workspaces/:workspaceId/suppressions`, the same path
 * convention as `mailboxApi` / `mailDomainsApi` (the workspace id is in the
 * path; errors throw `ApiError` with the status and the backend `message`).
 *
 * Measured from `SuppressionController` + `SuppressionService` (PR #52):
 * - GET returns `{ items, count }`. Each row is camelCase: `createdAt` is the
 *   ISO timestamp (there is no `created_at` on this route). Not paginated;
 *   the service returns the newest `SUPPRESSION_LIST_CAP` rows.
 * - Query `email` is an exact `@IsEmail` match. Query `reason` is the enum.
 * - POST body is `{ email, note? }` only. The server always records MANUAL;
 *   a `reason` field is rejected (`forbidNonWhitelisted`). Upsert on
 *   (workspace, email): a repeat replaces the reason and the note.
 * - DELETE is a signed-in human session. A personal access token gets 403
 *   (`Only a signed-in human may manage approvals.`). Success is `{ ok: true }`.
 */

import { ApiError, apiDelete, apiGet, apiPost } from '@/lib/api';

/** `SuppressionService.list` stops here (newest first). No page cursor. */
export const SUPPRESSION_LIST_CAP = 1000;

export const SUPPRESSION_REASONS = ['UNSUBSCRIBED', 'BOUNCED', 'COMPLAINT', 'MANUAL'] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export interface SuppressionView {
  id: string;
  email: string;
  reason: string;
  source: string;
  note: string | null;
  /** ISO timestamp. Live field name is `createdAt`. */
  createdAt: string;
}

export interface SuppressionListResponse {
  items: SuppressionView[];
  count: number;
}

export interface SuppressionListQuery {
  /** Exact address. The route rejects anything that is not a valid email. */
  email?: string;
  reason?: SuppressionReason;
}

export interface CreateSuppressionBody {
  email: string;
  note?: string;
}

const suppressionsBase = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/suppressions`;

function queryString(query: SuppressionListQuery | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  if (query.email) params.set('email', query.email);
  if (query.reason) params.set('reason', query.reason);
  const text = params.toString();
  return text ? `?${text}` : '';
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function isSuppressionReason(value: string): value is SuppressionReason {
  return (SUPPRESSION_REASONS as readonly string[]).includes(value);
}

/**
 * One row off the wire. `createdAt` is the live name; `created_at` is read
 * only as a fallback so a later snake_case pass does not blank the date.
 */
export function suppressionFromWire(raw: unknown): SuppressionView | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = asString(row.id);
  const email = asString(row.email);
  if (!id || !email) return null;
  return {
    id,
    email,
    reason: asString(row.reason) ?? '',
    source: asString(row.source) ?? '',
    note: asString(row.note),
    createdAt: asString(row.createdAt) ?? asString(row.created_at) ?? '',
  };
}

function listFromWire(raw: unknown): SuppressionListResponse {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const items = Array.isArray(body.items)
    ? body.items.map(suppressionFromWire).filter((row): row is SuppressionView => row !== null)
    : [];
  const count = typeof body.count === 'number' ? body.count : items.length;
  return { items, count };
}

/** List suppressions for a workspace (member). Optional exact email and reason. */
export async function listSuppressions(
  workspaceId: string,
  query?: SuppressionListQuery,
  token?: string,
): Promise<SuppressionListResponse> {
  const raw = await apiGet<unknown>(
    `${suppressionsBase(workspaceId)}${queryString(query)}`,
    token,
  );
  return listFromWire(raw);
}

/**
 * Manually suppress an address (member who can review the inbox). The server
 * records reason MANUAL and upserts on the address.
 */
export async function createSuppression(
  workspaceId: string,
  body: CreateSuppressionBody,
  token?: string,
): Promise<SuppressionView> {
  const raw = await apiPost<unknown>(suppressionsBase(workspaceId), body, token);
  const view = suppressionFromWire(raw);
  if (!view) {
    throw new ApiError(200, 'Suppression was saved but the response was not a row.');
  }
  return view;
}

/** Remove one suppression. A non-human session (PAT) is a 403 `ApiError`. */
export async function removeSuppression(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(
    `${suppressionsBase(workspaceId)}/${encodeURIComponent(id)}`,
    token,
  );
}
