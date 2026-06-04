import { ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { PostmarkWebhookGuard } from './postmark-webhook.guard';

/**
 * Provider-auth guard tests (the brief's "webhook secret rejection (401) +
 * disabled-by-flag (503)" requirements, plus the fail-closed no-secret 503 and
 * the accepted credential shapes).
 */

// A tiny fake ConfigService backed by a plain map.
function fakeConfig(env: Record<string, string | undefined>) {
  return { get: <T = string>(k: string): T | undefined => env[k] as unknown as T } as any;
}

// Build a fake ExecutionContext carrying a request with the given headers.
function ctxWithHeaders(headers: Record<string, string>): ExecutionContext {
  const req = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const SECRET = 's3cr3t-webhook-token';
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('PostmarkWebhookGuard', () => {
  it('503 when EMAIL_WEBHOOKS_ENABLED is off (default) — the route is never open', () => {
    const guard = new PostmarkWebhookGuard(
      fakeConfig({ EMAIL_WEBHOOKS_ENABLED: 'false', POSTMARK_WEBHOOK_SECRET: SECRET }),
    );
    expect(() => guard.canActivate(ctxWithHeaders({ authorization: basic('hook', SECRET) }))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('503 when the flag is on but POSTMARK_WEBHOOK_SECRET is unset (fail-closed; nothing to verify)', () => {
    const guard = new PostmarkWebhookGuard(
      fakeConfig({ EMAIL_WEBHOOKS_ENABLED: 'true', POSTMARK_WEBHOOK_SECRET: undefined }),
    );
    expect(() => guard.canActivate(ctxWithHeaders({ authorization: basic('hook', SECRET) }))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('401 when enabled+configured but NO credential is presented (forged/anon call)', () => {
    const guard = new PostmarkWebhookGuard(
      fakeConfig({ EMAIL_WEBHOOKS_ENABLED: 'true', POSTMARK_WEBHOOK_SECRET: SECRET }),
    );
    expect(() => guard.canActivate(ctxWithHeaders({}))).toThrow(UnauthorizedException);
  });

  it('401 when the presented secret does not match (forged call)', () => {
    const guard = new PostmarkWebhookGuard(
      fakeConfig({ EMAIL_WEBHOOKS_ENABLED: 'true', POSTMARK_WEBHOOK_SECRET: SECRET }),
    );
    expect(() =>
      guard.canActivate(ctxWithHeaders({ authorization: basic('hook', 'WRONG') })),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(ctxWithHeaders({ 'x-postmark-webhook-token': 'WRONG' })),
    ).toThrow(UnauthorizedException);
  });

  it('passes (true) with the correct secret via HTTP Basic (password component)', () => {
    const guard = new PostmarkWebhookGuard(
      fakeConfig({ EMAIL_WEBHOOKS_ENABLED: 'true', POSTMARK_WEBHOOK_SECRET: SECRET }),
    );
    expect(guard.canActivate(ctxWithHeaders({ authorization: basic('any-user', SECRET) }))).toBe(true);
  });

  it('passes (true) with the correct secret via the X-Postmark-Webhook-Token header', () => {
    const guard = new PostmarkWebhookGuard(
      fakeConfig({ EMAIL_WEBHOOKS_ENABLED: 'true', POSTMARK_WEBHOOK_SECRET: SECRET }),
    );
    expect(guard.canActivate(ctxWithHeaders({ 'x-postmark-webhook-token': SECRET }))).toBe(true);
  });

  it('passes (true) with the correct secret via Authorization: Bearer', () => {
    const guard = new PostmarkWebhookGuard(
      fakeConfig({ EMAIL_WEBHOOKS_ENABLED: 'true', POSTMARK_WEBHOOK_SECRET: SECRET }),
    );
    expect(guard.canActivate(ctxWithHeaders({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it('secretsMatch is length-safe + constant-time-shaped (no throw on mismatched lengths)', () => {
    expect(PostmarkWebhookGuard.secretsMatch('abc', 'abc')).toBe(true);
    expect(PostmarkWebhookGuard.secretsMatch('abc', 'abcd')).toBe(false);
    expect(PostmarkWebhookGuard.secretsMatch('', SECRET)).toBe(false);
  });
});
