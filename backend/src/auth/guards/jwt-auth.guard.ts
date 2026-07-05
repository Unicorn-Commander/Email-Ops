import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { PatService, PAT_PREFIX } from '../pat.service';

/**
 * Auth chokepoint for protected routes. Delegates to Passport's JWT strategy
 * (which resolves local HS256 session tokens, Keycloak realm RS256, and Brigade
 * federation RS256 — see jwt.strategy.ts). Routes flagged `@Public()` skip auth.
 *
 * Personal Access Tokens (SUITE-IDENTITY §D9, `eo_pat_` prefix) are a second,
 * orthogonal credential type layered on top of the same guard: a
 * `Bearer eo_pat_...` header is intercepted and resolved via PatService
 * BEFORE Passport ever sees it. Any other bearer value (a real JWT, or
 * nothing at all) falls through to the exact existing `super.canActivate`
 * behavior, untouched. A resolved PAT sets `req.user` to the same Prisma
 * `User` shape the JWT path yields, plus a non-persistent `__patAuth` marker
 * so downstream code (e.g. the /auth/pats controller) can tell a request was
 * authenticated via PAT rather than a real login.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private readonly patService: PatService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const bearer = JwtAuthGuard.extractBearer(request);

    // Anything other than an eo_pat_ token (a real JWT, or no header at all)
    // is completely unaffected — fall through to the untouched passport path.
    if (!bearer || !bearer.startsWith(PAT_PREFIX)) {
      return super.canActivate(context) as Promise<boolean>;
    }

    const user = await this.patService.resolvePat(bearer);
    if (!user) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('WWW-Authenticate', 'Bearer realm="email-ops-mcp"');
      throw new UnauthorizedException('Invalid or revoked personal access token');
    }

    const augmented = user as typeof user & { __patAuth?: boolean };
    augmented.__patAuth = true;
    request.user = augmented;
    return true;
  }

  private static extractBearer(request: Request): string | null {
    const header = request.headers?.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return null;
    }
    return header.slice('Bearer '.length).trim();
  }
}
