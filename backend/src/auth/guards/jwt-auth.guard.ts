import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { PatService, PAT_PREFIX, ResolvedPatRecord } from '../pat.service';
import { checkPat, PatRecord } from '../pat-scope';

export type PatAuthenticatedUser = ResolvedPatRecord['user'] & { __patAuth: PatRecord };

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
 * `User` shape the JWT path yields, plus a non-persistent `__patAuth` record
 * containing the scopes and lifecycle stamps needed at MCP dispatch.
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

    const record = await this.patService.resolvePatRecord(bearer);
    if (!record) {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('WWW-Authenticate', 'Bearer realm="email-ops-mcp"');
      throw new UnauthorizedException('Invalid personal access token');
    }

    // Authentication freshness is global, including non-MCP protected routes.
    // Scope authorization remains at the MCP dispatch choke point.
    const validity = checkPat(record, '*', new Date().toISOString());
    if (!validity.ok && validity.reason !== 'missing-scope') {
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader('WWW-Authenticate', 'Bearer realm="email-ops-mcp"');
      throw new UnauthorizedException(`Personal access token ${validity.reason}`);
    }

    const augmented = record.user as PatAuthenticatedUser;
    augmented.__patAuth = {
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      revokedAt: record.revokedAt,
    };
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
