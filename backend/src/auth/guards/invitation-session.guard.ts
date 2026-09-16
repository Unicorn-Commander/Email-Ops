import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

/** Run after JwtAuthGuard: MCP PAT scopes do not authorize membership changes
 * or disclosure of cross-workspace invitation capabilities. */
@Injectable()
export class InvitationSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (request.user?.__patAuth || request.user?.__isFederationActor ||
        /^Bearer\s+eo_pat_/i.test(request.headers?.authorization ?? '')) {
      throw new ForbiddenException('Invitations require a signed-in user session.');
    }
    return true;
  }
}
