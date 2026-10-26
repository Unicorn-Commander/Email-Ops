import { ConfigService } from '@nestjs/config';
import { CalendarBridgeClient, CalendarBridgeError } from './calendar-bridge.client';

function config(values: Record<string, string>): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
  } as unknown as ConfigService;
}

describe('CalendarBridgeClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the bridge bearer and idempotency key without exposing the token in errors', async () => {
    const client = new CalendarBridgeClient(
      config({
        CALENDAR_BRIDGE_URL: 'https://bridge.example.test/',
        CALENDAR_BRIDGE_TOKEN: 'fictional-bridge-token',
      }),
    );
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          app_id: 'app_runtime',
          secret: 'runtime-secret',
          username: 'person@example.test*app_runtime',
          expires_at: '2026-10-26T00:00:00+00:00',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await client.createKey(
      { login: 'person@example.test', label: 'Phone', purpose: 'device', ttl_seconds: 10 },
      'retry-key',
    );
    expect(result.username).toContain('app_runtime');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bridge.example.test/v1/keys',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer fictional-bridge-token',
          'Idempotency-Key': 'retry-key',
        }),
      }),
    );

    fetchMock.mockResolvedValueOnce(
      new Response('bridge body contains a credential', { status: 502 }),
    );
    await expect(client.revokeKey('app_runtime')).rejects.toEqual(
      expect.objectContaining({ status: 502, message: 'Calendar bridge request failed.' }),
    );
  });

  it('stays unconfigured when either bridge environment value is absent', async () => {
    const client = new CalendarBridgeClient(config({ CALENDAR_BRIDGE_URL: 'https://bridge.example.test' }));
    expect(client.isConfigured()).toBe(false);
    await expect(
      client.listKeys('person@example.test'),
    ).rejects.toEqual(expect.objectContaining({ status: 503 } as Partial<CalendarBridgeError>));
  });
});
