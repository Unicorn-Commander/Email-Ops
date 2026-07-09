/**
 * Typed browser client for the per-workspace mailbox registry (Phase 6).
 *
 * A mailbox is a first-class sending identity in a workspace: a human's own box,
 * an agent's sending box, or a shared team box. Each carries a provisioning
 * state (registered → provisioning → provisioned / failed) the backend owns, and
 * may be wired to a Postmark transactional lane. This module is the thin typed
 * layer over `/workspaces/:wsId/mailboxes` — the wire shape is snake_case and
 * mirrors the backend MailboxView exactly. RLS + the duplicate-address (409) and
 * provisioning-policy (403) guards live server-side; this is just the client.
 *
 * Shape mirrors the agent registry helpers in `@/lib/api`: one fetch/create/get/
 * update per route, each throwing `ApiError` (status-bearing) on non-2xx so the
 * page can branch on 401/403/404/409.
 */

import { apiGet, apiPatch, apiPost } from '@/lib/api';

/** Who a mailbox belongs to — drives grouping + the higher-trust agent note. */
export type MailboxOwnerKind = 'HUMAN' | 'AGENT' | 'SHARED';

/** Backend-owned lifecycle of a mailbox's underlying provisioning. */
export type MailboxProvisionState =
  | 'REGISTERED'
  | 'PROVISIONING'
  | 'PROVISIONED'
  | 'PROVISION_FAILED';

/** One mailbox (mirrors the backend MailboxView wire shape; snake_case). */
export interface MailboxView {
  id: string;
  email_address: string;
  display_name: string | null;
  owner_kind: MailboxOwnerKind;
  owner_key: string | null;
  kind: string;
  provider?: string | null;
  provision_state: MailboxProvisionState;
  is_default: boolean;
  postmark_lane: boolean;
  active: boolean;
  agent_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateMailboxBody {
  email_address: string;
  display_name?: string;
  owner_kind?: MailboxOwnerKind;
  owner_key?: string;
  postmark_lane?: boolean;
}

export interface UpdateMailboxBody {
  display_name?: string | null;
  owner_kind?: MailboxOwnerKind;
  owner_key?: string | null;
  postmark_lane?: boolean;
  active?: boolean;
}

export interface MailboxListResponse {
  items: MailboxView[];
  count: number;
}

const mailboxesBase = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/mailboxes`;

/** List the mailboxes for a workspace. */
export async function listMailboxes(
  workspaceId: string,
  token?: string,
): Promise<MailboxListResponse> {
  return apiGet<MailboxListResponse>(mailboxesBase(workspaceId), token);
}

/** Fetch a single mailbox by id (404 if missing). */
export async function getMailbox(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<MailboxView> {
  return apiGet<MailboxView>(`${mailboxesBase(workspaceId)}/${encodeURIComponent(id)}`, token);
}

/**
 * Create a mailbox (409 on duplicate address, 403 if the provisioning policy
 * denies the create — both surface inline via ApiError.status).
 */
export async function createMailbox(
  workspaceId: string,
  body: CreateMailboxBody,
  token?: string,
): Promise<MailboxView> {
  return apiPost<MailboxView>(mailboxesBase(workspaceId), body, token);
}

/** Update a mailbox's display name / owner / lane / active flag (404 if missing). */
export async function updateMailbox(
  workspaceId: string,
  id: string,
  body: UpdateMailboxBody,
  token?: string,
): Promise<MailboxView> {
  return apiPatch<MailboxView>(`${mailboxesBase(workspaceId)}/${encodeURIComponent(id)}`, body, token);
}
