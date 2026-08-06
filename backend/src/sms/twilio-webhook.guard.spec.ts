import { ExecutionContext, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwilioWebhookGuard } from './twilio-webhook.guard';

function ctx(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function guard(env: Record<string, string | undefined>): TwilioWebhookGuard {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new TwilioWebhookGuard(config);
}

const SECRET = 's3cr3t-token';

describe('TwilioWebhookGuard (fail-closed provider auth)', () => {
  it('503 when SMS_WEBHOOKS_ENABLED is off (default)', () => {
    expect(() => guard({ TWILIO_WEBHOOK_SECRET: SECRET }).canActivate(ctx({}))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('503 when enabled but no secret is configured (refuse forgeable calls)', () => {
    expect(() => guard({ SMS_WEBHOOKS_ENABLED: 'true' }).canActivate(ctx({}))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('401 when no credential is presented', () => {
    expect(() =>
      guard({ SMS_WEBHOOKS_ENABLED: 'true', TWILIO_WEBHOOK_SECRET: SECRET }).canActivate(ctx({})),
    ).toThrow(UnauthorizedException);
  });

  it('401 on a wrong secret', () => {
    expect(() =>
      guard({ SMS_WEBHOOKS_ENABLED: '1', TWILIO_WEBHOOK_SECRET: SECRET }).canActivate(
        ctx({ authorization: 'Bearer nope' }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('passes with the correct secret via Bearer', () => {
    expect(
      guard({ SMS_WEBHOOKS_ENABLED: 'on', TWILIO_WEBHOOK_SECRET: SECRET }).canActivate(
        ctx({ authorization: `Bearer ${SECRET}` }),
      ),
    ).toBe(true);
  });

  it('passes with the correct secret as the Basic password component', () => {
    const basic = `Basic ${Buffer.from(`twilio:${SECRET}`).toString('base64')}`;
    expect(
      guard({ SMS_WEBHOOKS_ENABLED: 'true', TWILIO_WEBHOOK_SECRET: SECRET }).canActivate(
        ctx({ authorization: basic }),
      ),
    ).toBe(true);
  });

  it('passes with the X-Twilio-Webhook-Token header', () => {
    expect(
      guard({ SMS_WEBHOOKS_ENABLED: 'true', TWILIO_WEBHOOK_SECRET: SECRET }).canActivate(
        ctx({ 'x-twilio-webhook-token': SECRET }),
      ),
    ).toBe(true);
  });
});
