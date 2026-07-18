/**
 * Active-Space selection — the one rule for "which Space is a screen scoped to".
 *
 * The active Space filters the `/mail` mailbox picker and the `/agents` list, and
 * names the Top-bar switcher. It is persisted PER WORKSPACE in localStorage so it
 * survives reloads and never leaks across workspaces, and defaults to the
 * sentinel `ALL_SPACE_ID` ("All inboxes" = everything, no filter).
 *
 * Besides the user's real (backend) Spaces there are three CANONICAL client-only
 * pseudo-spaces, pinned at the top of the switcher and never sent to the backend:
 *
 *   `ALL_SPACE_ID`     ('all')       — "All inboxes": no filter (legacy sentinel;
 *                                      `CANONICAL_ALL_ALIAS` '__all__' is an
 *                                      accepted alias that normalizes to it, so
 *                                      both spellings work everywhere).
 *   `MY_MAIL_SPACE_ID` ('__mine__')  — "My mail": mailboxes whose owner_kind is
 *                                      HUMAN or SHARED (includes Gmail/M365-
 *                                      connected boxes); no agents.
 *   `AGENTS_SPACE_ID`  ('__agents__')— "Agents": AGENT-owned mailboxes + the
 *                                      whole agent fleet.
 *
 * `ActiveSpaceProvider` resolves the canonical ids into computed mailbox/agent id
 * sets so every consumer (the `/mail` picker, the `/agents` list) filters them
 * exactly like a real Space. They persist through the same per-workspace storage
 * ("All" still clears the entry), and `ui_switch_space` (MCP) can target them.
 *
 * This module owns only the constants + storage helpers + the cross-surface
 * change event; the live state lives in `components/ActiveSpaceProvider.tsx`
 * (mirroring how `lib/workspace.ts` owns the rule and the hooks own the state).
 */

/** The implicit "All inboxes" space — everything, no filter. Never sent to the backend. */
export const ALL_SPACE_ID = 'all';

/**
 * Accepted alias for `ALL_SPACE_ID` (the canonical-trio spelling). Normalized to
 * `'all'` on every write path — `'all'` stays the stored/wire form because the
 * MCP `ui_switch_space` contract documents it.
 */
export const CANONICAL_ALL_ALIAS = '__all__';

/** Canonical "My mail" — HUMAN + SHARED mailboxes (your own + connected accounts). */
export const MY_MAIL_SPACE_ID = '__mine__';

/** Canonical "Agents" — AGENT-owned mailboxes + the agent fleet. */
export const AGENTS_SPACE_ID = '__agents__';

/** Collapse the '__all__' alias onto the stored `ALL_SPACE_ID`; other ids pass through. */
export function normalizeSpaceId(id: string): string {
  return id === CANONICAL_ALL_ALIAS ? ALL_SPACE_ID : id;
}

/** True for the canonical client-only pseudo-space ids (they never exist server-side). */
export function isCanonicalSpaceId(id: string): boolean {
  return (
    id === ALL_SPACE_ID ||
    id === CANONICAL_ALL_ALIAS ||
    id === MY_MAIL_SPACE_ID ||
    id === AGENTS_SPACE_ID
  );
}

const STORAGE_PREFIX = 'email-ops:active-space:';

/**
 * The cross-surface nudge: a mutation (create/rename/delete/membership) dispatches
 * this so ambient readers (the Top-bar switcher, the scoped pages) re-probe —
 * mirroring `useAgentInbox`'s `'agent-inbox:changed'` event.
 */
export const SPACES_CHANGED_EVENT = 'spaces:changed';

function storageKey(workspaceId: string): string {
  return `${STORAGE_PREFIX}${workspaceId}`;
}

/**
 * Read the persisted active-space id for a workspace (defaults to "All").
 * Canonical ids round-trip; a stored '__all__' alias normalizes to `ALL_SPACE_ID`.
 */
export function readStoredActiveSpaceId(workspaceId: string): string {
  if (typeof window === 'undefined') return ALL_SPACE_ID;
  try {
    return normalizeSpaceId(window.localStorage.getItem(storageKey(workspaceId)) || ALL_SPACE_ID);
  } catch {
    // localStorage can be unavailable (private mode, etc.).
    return ALL_SPACE_ID;
  }
}

/** Persist the active-space id for a workspace ("All" clears the entry). */
export function writeStoredActiveSpaceId(workspaceId: string, spaceId: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (spaceId === ALL_SPACE_ID) {
      window.localStorage.removeItem(storageKey(workspaceId));
    } else {
      window.localStorage.setItem(storageKey(workspaceId), spaceId);
    }
  } catch {
    // localStorage can be unavailable.
  }
}

/** Broadcast that the Spaces set changed so ambient surfaces re-probe. */
export function emitSpacesChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(SPACES_CHANGED_EVENT));
  }
}
