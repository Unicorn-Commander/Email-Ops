import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

/**
 * Auth chokepoint for protected routes. Delegates to Passport's JWT strategy
 * (which resolves local HS256 session tokens, Keycloak realm RS256, and Brigade
 * federation RS256 — see jwt.strategy.ts). Routes flagged `@Public()` skip auth.
 *
 * Phase 1 has no Personal Access Token path (PATs are a Phase-2+ surface;
 * SUITE-IDENTITY §D9 reserves the `eo_pat_` prefix for Email-Ops).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    return super.canActivate(context);
  }
}
