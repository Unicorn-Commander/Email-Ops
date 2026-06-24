/**
 * Workspace-role ranking — the ordered comparison the RBAC gates need.
 *
 * The suite roles rank VIEWER < MEMBER < MANAGER < ADMIN < OWNER (SUITE-IDENTITY
 * §7). Today the membership guard resolves a workspace but DISCARDS the role;
 * the provisioning policy needs "is the caller at least MANAGER/ADMIN?". Pure +
 * exhaustively unit-tested; no Nest/Prisma runtime deps beyond the enum type.
 */

import { WorkspaceRole } from '@prisma/client';

const RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  MANAGER: 2,
  ADMIN: 3,
  OWNER: 4,
};

export function roleRank(role: WorkspaceRole): number {
  return RANK[role] ?? 0;
}

/** Is `role` at least `min` on the ladder? */
export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return roleRank(role) >= roleRank(min);
}
