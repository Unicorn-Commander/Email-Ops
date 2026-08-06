/**
 * Typed browser client for "UI commands" — the AG-UI / frontend-tools seam that
 * lets an external agent drive the user's open cockpit (Phase C).
 *
 * An MCP client (authed as the user) calls a `ui_*` tool → the backend enqueues a
 * UI command addressed to that user's (workspaceId, ucUid) → the cockpit drains
 * it here on a focus-gated poll and APPLIES it (navigate, open a thread, prefill a
 * compose, switch the active Space, or show a toast). These commands have no
 * external side effects, so they bypass the compose-autonomy / agent-inbox gate;
 * anything irreversible still stays human-in-the-loop (a `compose` PREFILLS, it
 * does not send).
 *
 * This module mirrors `lib/spacesApi.ts`: the route is workspace-scoped (the
 * tenancy seam), wire shapes are snake_case and typed verbatim, and it reuses the
 * shared `apiGet` from `@/lib/api` (auth, error extraction, JSON) without ever
 * editing that file. The drain endpoint is read-once: it RETURNS + MARKS CONSUMED
 * the caller's pending commands (at-most-once delivery — across multiple tabs,
 * one tab wins), so callers must apply whatever they receive.
 */

import { apiGet } from '@/lib/api';

/** The frozen UI-command vocabulary (the kind discriminator on the wire). */
export type UiCommandKind = 'navigate' | 'open_thread' | 'compose' | 'switch_space' | 'notify';

/** A `notify` command's severity → maps to the toast tone. */
export type UiNotifyTone = 'info' | 'success' | 'warning';

/** `navigate` → push an app route (e.g. `/mail`, `/agents`, `/dashboard`). */
export interface UiNavigatePayload {
  path: string;
}

/** `open_thread` → open a mail thread (optionally switching mailbox first). */
export interface UiOpenThreadPayload {
  mailbox_id?: string;
  thread_id: string;
}

/** `compose` → PREFILL the composer (never auto-sends). `thread_id` threads it. */
export interface UiComposePayload {
  to?: string;
  subject?: string;
  body?: string;
  thread_id?: string;
}

/** `switch_space` → switch the active Space (`space_id`, or the `'all'` sentinel). */
export interface UiSwitchSpacePayload {
  space_id: string;
}

/** `notify` → surface a toast. */
export interface UiNotifyPayload {
  title: string;
  body?: string;
  tone?: UiNotifyTone;
}

/** Fields every drained command carries, regardless of kind. */
interface UiCommandBase {
  id: string;
  created_at: string;
}

/**
 * One drained command — a discriminated union over `kind`, so a consumer that
 * `switch`es on `kind` gets the correctly-typed `payload`. This is a faithful,
 * just-more-precise typing of the wire `{ id, kind, payload, created_at }` (the
 * backend sends `payload` as opaque JSON; here it is narrowed per kind).
 */
export type UiCommandView =
  | (UiCommandBase & { kind: 'navigate'; payload: UiNavigatePayload })
  | (UiCommandBase & { kind: 'open_thread'; payload: UiOpenThreadPayload })
  | (UiCommandBase & { kind: 'compose'; payload: UiComposePayload })
  | (UiCommandBase & { kind: 'switch_space'; payload: UiSwitchSpacePayload })
  | (UiCommandBase & { kind: 'notify'; payload: UiNotifyPayload });

/** The drain response: the caller's pending commands (oldest first) + a count. */
export interface DrainUiCommandsResponse {
  commands: UiCommandView[];
  count: number;
}

const seg = encodeURIComponent;

const uiCommandsBase = (workspaceId: string) => `/workspaces/${seg(workspaceId)}/ui-commands`;

/**
 * Drain (read-once) the caller's pending UI commands for a workspace. The backend
 * returns the caller's PENDING commands for (workspaceId, ucUid) — oldest first,
 * only those created in the last 5 minutes — and MARKS THEM CONSUMED in the same
 * request (at-most-once delivery). A 401 means the session lapsed; any other
 * failure should be swallowed by the caller so the cockpit never breaks.
 */
export async function drainUiCommands(
  workspaceId: string,
  token?: string,
): Promise<DrainUiCommandsResponse> {
  return apiGet<DrainUiCommandsResponse>(uiCommandsBase(workspaceId), token);
}
