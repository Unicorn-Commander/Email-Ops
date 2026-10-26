import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';

/** Approval/MCP identities must reflect an explicitly supplied agent credential,
 * even when a browser's human session cookie is present on the same request. */
@Injectable()
export class ExplicitCredentialGuard implements CanActivate {
  constructor(private readonly jwt: JwtAuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const cookie = req.headers.cookie;
    try {
      if (req.headers.authorization) req.headers.cookie = undefined;
      return await this.jwt.canActivate(context);
    } finally {
      req.headers.cookie = cookie;
    }
  }
}
