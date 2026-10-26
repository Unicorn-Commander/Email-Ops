import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class ApprovalTokensService {
  constructor(private readonly config: ConfigService) {}

  private signature(purpose: 'link' | 'session', data: string): Buffer {
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) throw new ServiceUnavailableException('Approval signing is not configured.');
    return createHmac('sha256', secret).update(`email-ops:approval:${purpose}:v1:${data}`).digest();
  }

  sign(purpose: 'link' | 'session', value: object): string {
    const data = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${data}.${this.signature(purpose, data).toString('base64url')}`;
  }

  verify<T>(purpose: 'link' | 'session', token: string): T {
    try {
      if (
        typeof token !== 'string' ||
        token.length > 8000 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw new Error();
      const [data, encoded] = token.split('.');
      const expected = this.signature(purpose, data);
      const actual = Buffer.from(encoded, 'base64url');
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected) ||
        actual.toString('base64url') !== encoded
      )
        throw new Error();
      return JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as T;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException('This approval credential is invalid.');
    }
  }

  linkUrl(token: string, workspaceId: string, kind: string, id: string): string {
    const base = (this.config.get<string>('FRONTEND_URL') || '').replace(/\/$/, '');
    // A fragment stays out of HTTP access logs and referrer headers.
    return `${base}/approve#${new URLSearchParams({ token, workspace: workspaceId, kind, id })}`;
  }
}
