import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';

/**
 * Injects the caller's resolved WorkspaceRole in the request's workspace — the
 * role the WorkspaceMembershipGuard stashed on `req.workspaceRole` (flag OFF →
 * OWNER, the single-tenant operator). The provisioning RBAC gates read it.
 * Fail-closed to VIEWER if the guard didn't run (it always should on guarded
 * routes; the fallback keeps the decorator honest if misused).
 *
 *   create(@WorkspaceRoleParam() role: WorkspaceRole, …)
 */
export const WorkspaceRoleParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceRole => {
    const req = ctx.switchToHttp().getRequest();
    const role = req?.workspaceRole;
    return (role ?? WorkspaceRole.VIEWER) as WorkspaceRole;
  },
);
