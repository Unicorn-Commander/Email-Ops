import {
  credentialTracker,
  ipTracker,
  requestIp,
  throttlePrincipalKind,
  throttleProfile,
} from './identity-throttle';

describe('identity-throttle trackers', () => {
  it('requestIp ignores client-supplied X-Forwarded-For (spoofable) and uses req.ip', () => {
    expect(
      requestIp({
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
        ips: ['203.0.113.9', '10.0.0.1'],
        ip: '10.0.0.1',
      }),
    ).toBe('10.0.0.1');
  });

  it('rotating fake X-Forwarded-For still lands in one ip bucket', async () => {
    const a = await ipTracker({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '1.1.1.1' } });
    const b = await ipTracker({ ip: '10.0.0.1', headers: { 'x-forwarded-for': '2.2.2.2' } });
    expect(a).toBe(b);
  });

  it('requestIp uses req.ip', () => {
    expect(requestIp({ headers: {}, ip: '192.0.2.10' })).toBe('192.0.2.10');
  });

  it('credentialTracker keys verified req.user.id ahead of the Bearer', async () => {
    const a = await credentialTracker({
      user: { id: 'user-a' },
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.aaa.sig' },
      ip: '10.0.0.1',
    });
    const b = await credentialTracker({
      user: { id: 'user-b' },
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.aaa.sig' },
      ip: '10.0.0.1',
    });
    expect(a).toBe('user:user-a');
    expect(b).toBe('user:user-b');
    expect(a).not.toBe(b);
  });

  it('credentialTracker falls back to a Bearer digest so two JWTs on one IP split', async () => {
    const shared = { ip: '10.1.1.1', headers: {} };
    const persephone = await credentialTracker({
      ...shared,
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.persephone.sig' },
    });
    const cockpit = await credentialTracker({
      ...shared,
      headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.cockpit.sig' },
    });
    expect(persephone.startsWith('cred:')).toBe(true);
    expect(cockpit.startsWith('cred:')).toBe(true);
    expect(persephone).not.toBe(cockpit);
  });

  it('credentialTracker uses IP when there is no credential', async () => {
    expect(await credentialTracker({ ip: '198.51.100.7', headers: {} })).toBe('ip:198.51.100.7');
  });

  it('same Bearer on the same IP reuses the credential bucket', async () => {
    const req = {
      ip: '10.1.1.1',
      headers: { authorization: 'Bearer eo_pat_ABCDEFGHJKMN0123' },
    };
    expect(await credentialTracker(req)).toBe(await credentialTracker({ ...req }));
  });

  it('session cookies get their own credential bucket', async () => {
    const tracker = await credentialTracker({
      ip: '10.1.1.1',
      headers: { cookie: 'access_token=fixture.header.payload' },
    });
    expect(tracker).toMatch(/^session:/);
  });

  it('ipTracker is IP-only so rotating Bearers still share a ceiling', async () => {
    const ip = '10.9.9.9';
    const a = await ipTracker({
      ip,
      headers: { authorization: 'Bearer aaaaaaaaaaaaaaaaa' },
    });
    const b = await ipTracker({
      ip,
      headers: { authorization: 'Bearer bbbbbbbbbbbbbbbbb' },
    });
    expect(a).toBe('ip:10.9.9.9');
    expect(b).toBe(a);
  });
});

describe('principal-specific throttle profiles', () => {
  const envNames = [
    'THROTTLE_SESSION_SHORT',
    'THROTTLE_SESSION_LONG',
    'THROTTLE_CREDENTIAL_SHORT',
    'THROTTLE_CREDENTIAL_LONG',
  ] as const;
  const saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const name of envNames) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each([
    [
      'session cookie',
      { headers: { cookie: 'access_token=fixture.header.payload' } },
      'session',
      { short: 300, long: 5000 },
    ],
    [
      'PAT',
      { headers: { authorization: 'Bearer eo_pat_fixture_token_12345' } },
      'pat',
      { short: 20, long: 200 },
    ],
    [
      'MCP bearer',
      {
        path: '/api/v1/mcp',
        headers: { authorization: 'Bearer fixture-mcp-token-12345' },
      },
      'mcp',
      { short: 20, long: 200 },
    ],
    [
      'anonymous malformed bearer',
      { headers: { authorization: 'Bearer malformed-agent-credential' } },
      'anonymous',
      { short: 20, long: 200 },
    ],
    [
      'anonymous malformed cookie',
      { headers: { cookie: 'access_token=malformed-session-cookie' } },
      'anonymous',
      { short: 20, long: 200 },
    ],
    ['anonymous', { ip: '192.0.2.10', headers: {} }, 'anonymous', { short: 20, long: 200 }],
  ])('%s resolves to its expected principal and profile', (_label, req, kind, profile) => {
    expect(throttlePrincipalKind(req)).toBe(kind);
    expect(throttleProfile(req)).toEqual(profile);
  });

  it('reads session and strict profile limits from their environment variables', () => {
    process.env.THROTTLE_SESSION_SHORT = '301';
    process.env.THROTTLE_SESSION_LONG = '5001';
    process.env.THROTTLE_CREDENTIAL_SHORT = '21';
    process.env.THROTTLE_CREDENTIAL_LONG = '201';

    expect(throttleProfile({ headers: { cookie: 'access_token=fixture.header.payload' } })).toEqual(
      { short: 301, long: 5001 },
    );
    expect(
      throttleProfile({ headers: { authorization: 'Bearer eo_pat_fixture_token_12345' } }),
    ).toEqual({ short: 21, long: 201 });
  });

  it('a verified PAT marker wins over a browser cookie', () => {
    expect(
      throttlePrincipalKind({
        headers: {
          cookie: 'access_token=fixture.header.payload',
          authorization: 'Bearer eo_pat_fixture_token_12345',
        },
        user: { id: 'fixture-user', __patAuth: { scopes: ['mail:read'] } },
      }),
    ).toBe('pat');
  });
});
