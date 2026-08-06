import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { MembershipService } from './membership.service';
import { resolveWorkspaceId, defaultWorkspaceId, WithWorkspaceClaim } from './workspace.util';

/**
 * Gate for workspace-scoped routes (SUITE-IDENTITY §D4/§D5).
 *
 * Addressing precedence for the requested workspace (D4):
 *   path param `workspaceId`/`workspace_id` → `X-Workspace-Id` header →
 *   `workspace_id` claim (surfaced as req.user.__workspaceClaim).
 *
 * Behavior is gated by EMAIL_OPS_TENANCY_ENABLED (default OFF) inside
 * MembershipService.resolveAndAuthorize:
 *   - OFF: no-op (resolves to default; never throws) — today's behavior.
 *   - ON : 403 unless the user has an active Membership in the resolved
 *          workspace; the resolved id is stashed on `req.workspaceId` for
 *          handlers / the GUC chokepoint to consume.
 *
 * This guard is additive: it is NOT applied globally. Routes opt in via
 * `@UseGuards(WorkspaceMembershipGuard)`. Wiring it onto the workspace REST
 * surface is the Phase-2+ step that flips alongside the runtime role.
 */
@Injectable()
export class WorkspaceMembershipGuard implements CanActivate {
  constructor(private readonly membership: MembershipService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user: (User & Partial<WithWorkspaceClaim>) | undefined = req?.user;
    if (!user) {
      // No authenticated user — let the auth guard own this; don't mask a 401.
      throw new ForbiddenException('Authentication required.');
    }

    const requested =
      req?.params?.workspaceId ??
      req?.params?.workspace_id ??
      req?.headers?.['x-workspace-id'] ??
      resolveWorkspaceId(user, defaultWorkspaceId());

    const { workspaceId, role } = await this.membership.resolveWithRole(user, requested);
    // Stash for downstream handlers + the withWorkspace GUC chokepoint, and the
    // caller's role for the provisioning RBAC gates (@WorkspaceRole()).
    req.workspaceId = workspaceId;
    req.workspaceRole = role;
    return true;
  }
}
