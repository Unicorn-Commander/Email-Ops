/**
 * Active-Space selection — the one rule for "which Space is a screen scoped to".
 *
 * The active Space filters the `/mail` mailbox picker and the `/agents` list, and
 * names the Top-bar switcher. It is persisted PER WORKSPACE in localStorage so it
 * survives reloads and never leaks across workspaces, and defaults to the
 * sentinel `ALL_SPACE_ID` ("All" = everything, no filter).
 *
 * This module owns only the constants + storage helpers + the cross-surface
 * change event; the live state lives in `components/ActiveSpaceProvider.tsx`
 * (mirroring how `lib/workspace.ts` owns the rule and the hooks own the state).
 */

/** The implicit "All" space — everything, no filter. Never sent to the backend. */
export const ALL_SPACE_ID = 'all';

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

/** Read the persisted active-space id for a workspace (defaults to "All"). */
export function readStoredActiveSpaceId(workspaceId: string): string {
  if (typeof window === 'undefined') return ALL_SPACE_ID;
  try {
    return window.localStorage.getItem(storageKey(workspaceId)) || ALL_SPACE_ID;
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
