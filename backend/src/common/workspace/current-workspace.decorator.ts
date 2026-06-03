import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { defaultWorkspaceId, resolveWorkspaceId } from './workspace.util';

/**
 * Injects the active workspace id into a controller handler.
 *
 *   list(@CurrentWorkspace() workspaceId: string, @CurrentUser() user: User)
 *
 * Resolves from the validated JWT claim that JwtStrategy attached to
 * `req.user.__workspaceClaim`, falling back to DEFAULT_WORKSPACE_ID. Never
 * reads an HTTP header (the suite model forbids trusting one for the tenancy
 * CLAIM; the WorkspaceMembershipGuard handles the addressing precedence that
 * may include a header).
 */
export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return resolveWorkspaceId(request?.user, defaultWorkspaceId());
  },
);
