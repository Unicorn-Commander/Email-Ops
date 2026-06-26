/**
 * Active-Organization selection — the one rule for "which org the whole app is
 * scoped to". An Organization IS the existing `Workspace` (the hard multi-tenant
 * boundary); Spaces, mailboxes, agents and the agent-inbox all live INSIDE it.
 *
 * Unlike the active SPACE (persisted PER workspace in `lib/activeSpace.ts`), the
 * active ORG is the outermost tenant, so it is persisted under a single GLOBAL
 * localStorage key — there is nothing "outside" it to scope the key by. There is
 * no sentinel either: the active org is always a concrete workspace id, or null
 * when the caller has no membership yet.
 *
 * This module owns only the storage helpers + the cross-surface change event;
 * the live state lives in `components/ActiveWorkspaceProvider.tsx` (mirroring how
 * `lib/workspace.ts` owns the rule and the provider owns the state).
 */

/** The single GLOBAL key the active-org id is persisted under (not per-workspace). */
const STORAGE_KEY = 'email-ops:active-workspace';

/**
 * The cross-surface nudge: switching / creating / accepting an org dispatches
 * this so ambient readers (the Top-bar switcher, the org provider's focus
 * re-probe) refresh — mirroring `lib/activeSpace.ts`'s `'spaces:changed'`.
 */
export const WORKSPACE_CHANGED_EVENT = 'workspace:changed';

/** Read the persisted active-org id (null when none has been chosen yet). */
export function readStoredActiveWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage can be unavailable (private mode, etc.).
    return null;
  }
}

/** Persist the active-org id (a null/empty value clears the entry). */
export function writeStoredActiveWorkspaceId(workspaceId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!workspaceId) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, workspaceId);
    }
  } catch {
    // localStorage can be unavailable.
  }
}

/** Broadcast that the active org changed so ambient surfaces re-probe. */
export function emitWorkspaceChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(WORKSPACE_CHANGED_EVENT));
  }
}
