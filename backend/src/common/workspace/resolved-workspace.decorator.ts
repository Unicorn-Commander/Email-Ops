import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Injects the workspace id the WorkspaceMembershipGuard resolved + authorized
 * for this request (it stashes the result on `req.workspaceId`).
 *
 *   list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User)
 *
 * Use this on routes guarded by WorkspaceMembershipGuard whose addressing is the
 * `…/workspaces/:workspaceId/…` PATH (SUITE-IDENTITY §D4: path wins). The guard
 * has already applied the D4 precedence (path → header → claim) and, when
 * tenancy is enabled, verified the caller's active membership in it — so reading
 * `req.workspaceId` is the authorized id, not raw user input.
 *
 * Falls back to the raw `:workspaceId` path param if the guard didn't run (it
 * always should on these routes; the fallback just keeps the decorator honest if
 * misused). Distinct from @CurrentWorkspace, which reads the JWT CLAIM for routes
 * that are NOT path-addressed.
 */
export const ResolvedWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest();
    const resolved = req?.workspaceId;
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    const param = req?.params?.workspaceId ?? req?.params?.workspace_id;
    return typeof param === 'string' ? param : '';
  },
);
