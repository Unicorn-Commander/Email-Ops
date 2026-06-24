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

/**
 * Pick the workspace a screen should operate in: the membership flagged
 * `is_default`, else the first one the user belongs to, else null (no
 * membership — the UI shows an explicit empty state rather than guessing).
 */
export function pickActiveWorkspace(list: MyWorkspace[]): MyWorkspace | null {
  return list.find((ws) => ws.is_default) ?? list[0] ?? null;
}
