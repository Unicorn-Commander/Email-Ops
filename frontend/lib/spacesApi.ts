/**
 * Typed browser client for "Spaces" — the soft, overlapping grouping of mailboxes
 * + agents inside a workspace (NOT a new tenant).
 *
 * A Space is either PERSONAL (only its owner sees it) or TEAM (shared across the
 * workspace). The active Space filters the `/mail` mailbox picker and the
 * `/agents` list; an implicit "All" space (the `ALL_SPACE_ID` sentinel in
 * `lib/activeSpace.ts`) means "no filter".
 *
 * This module mirrors `lib/mailApi.ts`: every route is workspace-scoped (the
 * tenancy seam), wire shapes are snake_case and typed verbatim with no remapping,
 * and it reuses the shared `apiGet`/`apiPost`/`apiPatch`/`apiPut`/`apiDelete`
 * from `@/lib/api` (auth, error extraction, JSON) without ever editing that file.
 *
 * The membership setters use REPLACE semantics — `setSpaceMailboxes` /
 * `setSpaceAgents` send the WHOLE set, and the backend swaps it in wholesale.
 * Errors surface verbatim through `ApiError` (400 = an id wasn't in the
 * workspace, 403 = editing someone else's PERSONAL space, 409 = a conflict).
 */

import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';

/** A Space is visible only to its owner (PERSONAL) or to the whole workspace (TEAM). */
export type SpaceVisibility = 'personal' | 'team';

/** One Space (mirrors the backend SpaceView wire shape; snake_case). */
export interface SpaceView {
  id: string;
  name: string;
  visibility: SpaceVisibility;
  /** Optional accent color (CSS color string, e.g. "#22c55e"); null = none. */
  color: string | null;
  /** Optional short glyph / emoji shown beside the name; null = none. */
  icon: string | null;
  sort_order: number;
  /** The mailboxes this Space scopes the mail picker to (REPLACE set). */
  mailbox_ids: string[];
  /** The agents this Space scopes the fleet list to (REPLACE set). */
  agent_ids: string[];
}

export interface SpacesListResponse {
  items: SpaceView[];
  count: number;
}

/** Body for creating a Space. Default visibility (server-side) = personal. */
export interface CreateSpaceBody {
  name: string;
  visibility?: SpaceVisibility;
  color?: string;
  icon?: string;
}

/** Body for editing a Space (all fields optional — PATCH semantics). */
export interface UpdateSpaceBody {
  name?: string;
  color?: string;
  icon?: string;
  sort_order?: number;
  visibility?: SpaceVisibility;
}

/** Body for the mailbox-membership setter (REPLACE the whole set). */
export interface SetSpaceMailboxesBody {
  mailbox_ids: string[];
}

/** Body for the agent-membership setter (REPLACE the whole set). */
export interface SetSpaceAgentsBody {
  agent_ids: string[];
}

const seg = encodeURIComponent;

const spacesBase = (workspaceId: string) => `/workspaces/${seg(workspaceId)}/spaces`;

/**
 * List the caller's visible Spaces — their PERSONAL spaces + all TEAM spaces,
 * sorted by sort_order then name (server-side). Does NOT include the implicit
 * "All" — that is a client-only sentinel.
 */
export async function listSpaces(
  workspaceId: string,
  token?: string,
): Promise<SpacesListResponse> {
  return apiGet<SpacesListResponse>(spacesBase(workspaceId), token);
}

/** Create a Space (defaults to PERSONAL visibility). Returns the created Space. */
export async function createSpace(
  workspaceId: string,
  body: CreateSpaceBody,
  token?: string,
): Promise<SpaceView> {
  return apiPost<SpaceView>(spacesBase(workspaceId), body, token);
}

/**
 * Edit a Space (name / color / icon / sort_order / visibility). A PERSONAL space
 * is editable only by its owner (else 403); a TEAM space by any member.
 */
export async function updateSpace(
  workspaceId: string,
  id: string,
  body: UpdateSpaceBody,
  token?: string,
): Promise<SpaceView> {
  return apiPatch<SpaceView>(`${spacesBase(workspaceId)}/${seg(id)}`, body, token);
}

/** Delete a Space (mailboxes/agents are untouched — only the grouping is removed). */
export async function deleteSpace(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(`${spacesBase(workspaceId)}/${seg(id)}`, token);
}

/**
 * REPLACE the Space's mailbox membership with `mailboxIds` (400 if an id isn't in
 * the workspace). Returns the refreshed Space.
 */
export async function setSpaceMailboxes(
  workspaceId: string,
  id: string,
  mailboxIds: string[],
  token?: string,
): Promise<SpaceView> {
  return apiPut<SpaceView>(
    `${spacesBase(workspaceId)}/${seg(id)}/mailboxes`,
    { mailbox_ids: mailboxIds } satisfies SetSpaceMailboxesBody,
    token,
  );
}

/**
 * REPLACE the Space's agent membership with `agentIds` (400 if an id isn't in the
 * workspace). Returns the refreshed Space.
 */
export async function setSpaceAgents(
  workspaceId: string,
  id: string,
  agentIds: string[],
  token?: string,
): Promise<SpaceView> {
  return apiPut<SpaceView>(
    `${spacesBase(workspaceId)}/${seg(id)}/agents`,
    { agent_ids: agentIds } satisfies SetSpaceAgentsBody,
    token,
  );
}
