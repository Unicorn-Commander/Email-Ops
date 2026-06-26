/**
 * Workspace selection helpers.
 *
 * Email-Ops scopes every agent-inbox / mailbox call to a workspace id (the
 * tenancy seam — see the backend RLS chokepoint). The browser learns the
 * caller's workspaces from `GET /auth/me/workspaces` (`fetchMyWorkspaces`); this
 * module owns the one rule for picking which one a screen operates in, so the
 * page, the nav badge, and any future surface agree on the same active
 * workspace instead of each re-deriving it.
 */

import type { MyWorkspace } from './api';
import { readStoredActiveWorkspaceId } from './activeWorkspace';

/**
 * Pick the workspace a screen should operate in. Now storage-aware as
 * belt-and-suspenders for the org switcher (`lib/activeWorkspace.ts`): a stored,
 * still-valid active-org id wins, so any caller that resolves the active
 * workspace this way honors a switch on its next natural resolve. Failing that:
 * the membership flagged `is_default`, else the first one the user belongs to,
 * else null (no membership — the UI shows an explicit empty state).
 *
 * The live, reactive source of truth is `useActiveWorkspace()`; prefer that in
 * components so a switch re-scopes immediately. This stays the one rule for code
 * paths that only have the raw list.
 */
export function pickActiveWorkspace(list: MyWorkspace[]): MyWorkspace | null {
  const storedId = readStoredActiveWorkspaceId();
  const stored = storedId ? list.find((ws) => ws.workspace_id === storedId) : undefined;
  return stored ?? list.find((ws) => ws.is_default) ?? list[0] ?? null;
}
