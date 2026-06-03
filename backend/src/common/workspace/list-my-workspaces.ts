import { User } from '@prisma/client';
import { MembershipService } from './membership.service';

/**
 * The canonical `list_my_workspaces` projection, shared by the REST surface
 * (`GET /auth/me/workspaces`) and the MCP tool of the same name so both return
 * an identical shape (SUITE-IDENTITY §9):
 *
 *   { workspace_id, slug, display_name, role (canonical suite role), is_default }
 *
 * Roles are already canonical suite WorkspaceRoles in Email-Ops; we emit the
 * lowercase suite-role string (viewer|member|manager|admin|owner) for the
 * cross-app interchange contract.
 */
export interface MyWorkspace {
  workspace_id: string;
  slug: string;
  display_name: string;
  role: string;
  is_default: boolean;
}

export async function listMyWorkspaces(
  membership: MembershipService,
  user: User,
): Promise<MyWorkspace[]> {
  const memberships = await membership.listActiveMemberships(user);
  if (memberships.length === 0) return [];

  const ids = memberships.map((m) => m.workspaceId);
  const workspaces = await membership.findWorkspaces(ids);
  const byId = new Map(workspaces.map((w) => [w.id, w]));

  return memberships.map((m) => {
    const ws = byId.get(m.workspaceId);
    return {
      workspace_id: m.workspaceId,
      slug: ws?.slug ?? m.workspaceId,
      display_name: ws?.displayName ?? ws?.slug ?? m.workspaceId,
      role: String(m.role).toLowerCase(),
      is_default: m.isDefault,
    };
  });
}
