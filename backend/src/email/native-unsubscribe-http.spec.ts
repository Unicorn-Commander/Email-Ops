import { NativeUnsubscribeHttpClient, isPublicAddress } from './native-unsubscribe-http';

class TestClient extends NativeUnsubscribeHttpClient {
  constructor(private readonly addresses: Array<{ address: string; family: number }>) {
    super({ get: () => undefined } as never);
  }
  protected override lookupHost(): Promise<Array<{ address: string; family: number }>> {
    return Promise.resolve(this.addresses);
  }
}

describe('native unsubscribe one-click: destination guard', () => {
  const fetchSpy = jest.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
  });

  it.each([
    ['10.1.2.3', false],
    ['172.16.0.9', false],
    ['172.32.0.1', true],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.7', false],
    ['100.128.0.1', true],
    ['8.8.8.8', true],
    ['::1', false],
    ['fd12::1', false],
    ['fe80::1', false],
    ['::ffff:10.0.0.1', false],
    ['2606:4700::1', true],
  ])('isPublicAddress(%s) = %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it('refuses a hostname that resolves to a private address and never fetches', async () => {
    const client = new TestClient([{ address: '10.0.0.5', family: 4 }]);
    const r = await client.postOneClick('https://unsubscribe.example/one-click');
    expect(r.accepted).toBe(false);
    expect(r.detail).toContain('not public');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a literal loopback / link-local host and localhost names', async () => {
    const client = new TestClient([]);
    for (const url of [
      'https://127.0.0.1/u',
      'https://[::1]/u',
      'https://169.254.169.254/latest',
      'https://localhost/u',
    ]) {
      const r = await client.postOneClick(url);
      expect(r.accepted).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it('posts to a public host', async () => {
    fetchSpy.mockResolvedValue({ status: 200 });
    const client = new TestClient([{ address: '203.0.113.10', family: 4 }]);
    const r = await client.postOneClick('https://unsubscribe.example/one-click');
    expect(r.accepted).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body: 'List-Unsubscribe=One-Click',
    });
  });
});
