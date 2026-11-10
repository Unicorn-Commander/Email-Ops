import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { provisioningEnabled } from '../common/workspace/feature-flags';

export interface ProvisioningPrincipal {
  sub?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  [claim: string]: unknown;
}

/** Hides the whole provisioning surface until the ring is deliberately enabled. */
@Injectable()
export class ProvisioningEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (!provisioningEnabled((key) => this.config.get<string>(key))) {
      throw new NotFoundException('Not found');
    }
    return true;
  }
}

/**
 * Verifies the service credential minted by Ops-Center. This is intentionally
 * separate from the user-session JwtAuthGuard: provisioning is a control-plane
 * callback and must not be reachable with a browser session or PAT.
 */
@Injectable()
export class OpsCenterServiceJwtGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = this.bearer(request?.headers?.authorization);
    const secret = this.firstConfigured([
      'PROVISIONING_SERVICE_JWT_SECRET',
      'OPS_CENTER_SERVICE_JWT_SECRET',
      'OPSCENTER_SERVICE_JWT_SECRET',
    ]);
    if (!token || !secret) {
      throw new UnauthorizedException('A valid Ops-Center service token is required.');
    }

    const audience =
      this.firstConfigured([
        'PROVISIONING_SERVICE_JWT_AUDIENCE',
        'OPS_CENTER_SERVICE_JWT_AUDIENCE',
      ]) || 'email-ops';
    const issuer = this.firstConfigured([
      'PROVISIONING_SERVICE_JWT_ISSUER',
      'OPS_CENTER_SERVICE_JWT_ISSUER',
    ]);

    try {
      const payload = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        audience,
        ...(issuer ? { issuer } : {}),
      });
      if (typeof payload === 'string' || !this.hasLiveExpiry(payload.exp)) {
        throw new Error('service token is missing a live exp claim');
      }
      request.provisioningPrincipal = payload as ProvisioningPrincipal;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired Ops-Center service token.');
    }
  }

  private bearer(header: unknown): string | null {
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    return token || null;
  }

  private firstConfigured(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.config.get<string>(key)?.trim();
      if (value) return value;
    }
    return undefined;
  }

  private hasLiveExpiry(value: unknown): value is number {
    return (
      typeof value === 'number' && Number.isFinite(value) && value > Math.floor(Date.now() / 1000)
    );
  }
}
