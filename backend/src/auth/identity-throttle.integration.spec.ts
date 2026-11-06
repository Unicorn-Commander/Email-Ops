import { Controller, Get, Module, Post, Res } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { INestApplication } from '@nestjs/common';
import { Response } from 'express';
import {
  credentialTracker,
  ipTracker,
  ProfiledThrottlerGuard,
  throttleIpLimit,
  throttleProfile,
} from './identity-throttle';

@Controller('auth')
class FixtureAuthController {
  @Post('local/login')
  login(@Res() response: Response) {
    response.setHeader('Set-Cookie', 'access_token=fixture.header.payload; Path=/; HttpOnly');
    return response.status(200).json({ user: { id: 'fixture-session-user' } });
  }
}

@Controller('lists')
class FixtureListController {
  @Get()
  list() {
    return { items: [] };
  }
}

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 60_000,
        limit: (context) => throttleProfile(context.switchToHttp().getRequest()).short,
        getTracker: credentialTracker,
      },
      {
        name: 'long',
        ttl: 3_600_000,
        limit: (context) => throttleProfile(context.switchToHttp().getRequest()).long,
        getTracker: credentialTracker,
      },
      { name: 'ip', ttl: 60_000, limit: () => throttleIpLimit(), getTracker: ipTracker },
    ]),
  ],
  controllers: [FixtureAuthController, FixtureListController],
  providers: [{ provide: APP_GUARD, useClass: ProfiledThrottlerGuard }],
})
class ThrottleFixtureModule {}

describe('principal-specific throttling (HTTP integration)', () => {
  let app: INestApplication;
  let origin: string;
  const envNames = [
    'THROTTLE_SESSION_SHORT',
    'THROTTLE_SESSION_LONG',
    'THROTTLE_CREDENTIAL_SHORT',
    'THROTTLE_CREDENTIAL_LONG',
    'THROTTLE_IP_PER_MIN',
  ] as const;
  const saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    for (const name of envNames) delete process.env[name];
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottleFixtureModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    for (const name of envNames) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('signs in a session user and permits 40 list requests without a 429', async () => {
    const login = await fetch(`${origin}/auth/local/login`, { method: 'POST' });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie');
    expect(setCookie).toContain('access_token=fixture.header.payload');
    const cookie = setCookie!.split(';', 1)[0];

    const responses = await Promise.all(
      Array.from({ length: 40 }, () => fetch(`${origin}/lists`, { headers: { cookie } })),
    );

    expect(responses.map((response) => response.status).filter((status) => status === 429)).toEqual(
      [],
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it('keeps a PAT at 20 requests per minute and rejects its 21st request', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await fetch(`${origin}/lists`, {
        headers: { authorization: 'Bearer eo_pat_fixture_token_12345' },
      });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
