import { credentialTracker, ipTracker, requestIp } from './identity-throttle';

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
    expect(await credentialTracker({ ip: '198.51.100.7', headers: {} })).toBe(
      'ip:198.51.100.7',
    );
  });

  it('same Bearer on the same IP reuses the credential bucket', async () => {
    const req = {
      ip: '10.1.1.1',
      headers: { authorization: 'Bearer eo_pat_ABCDEFGHJKMN0123' },
    };
    expect(await credentialTracker(req)).toBe(await credentialTracker({ ...req }));
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
