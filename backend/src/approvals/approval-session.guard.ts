import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { APPROVAL_COOKIE, ApprovalSessionService, cookieValue } from './approval-session.service';
import { assertHumanApproval } from './human-approval';

/** This guard is deliberately used ONLY on ApprovalController. */
@Injectable()
export class ApprovalSessionGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly sessions: ApprovalSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    // Approval requests are JSON fetches. SameSite plus an explicit same-origin
    // browser header prevents a cross-origin form from consuming a link.
    if (req.method !== 'GET' && req.headers['x-email-ops-approval'] !== '1') {
      throw new ForbiddenException('Use the approval page to review this request.');
    }
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException('Cross-site approval is not allowed.');
    const bearer = req.headers.authorization;
    const originalCookie = req.headers.cookie;
    let authenticated = false;
    try {
      // An explicit agent credential must never be hidden by a human cookie.
      if (bearer) req.headers.cookie = undefined;
      authenticated = await this.jwt.canActivate(context);
    } catch (error) {
      // Never downgrade an explicit bearer credential to the remembered cookie.
      if (bearer || !(error instanceof UnauthorizedException)) throw error;
    } finally {
      req.headers.cookie = originalCookie;
    }
    if (!authenticated) {
      const token = cookieValue(originalCookie, APPROVAL_COOKIE);
      if (!token) throw new UnauthorizedException('Sign in to review this approval.');
      req.user = await this.sessions.resolve(token);
    }
    assertHumanApproval(req.user);
    if (
      req.user.__approvalSession &&
      req.params.workspaceId !== req.user.__approvalSession.workspaceId
    ) {
      throw new ForbiddenException('This approval session belongs to a different workspace.');
    }
    return true;
  }
}
