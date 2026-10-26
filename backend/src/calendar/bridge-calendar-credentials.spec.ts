import { BridgeCalendarCredentials } from './bridge-calendar-credentials';
import { CalendarBridgeClient } from './calendar-bridge.client';

describe('BridgeCalendarCredentials', () => {
  const mailbox = {
    id: 'mailbox-1',
    emailAddress: 'person@example.test',
    provider: 'james',
    ownerKind: 'HUMAN',
    ownerKey: 'owner-1',
  };

  afterEach(() => jest.restoreAllMocks());

  it('caches a backend key until five minutes before Davis expiry', async () => {
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const createKey = jest.fn().mockResolvedValue({
      app_id: 'app_backend_1',
      secret: 'runtime-secret',
      username: 'person@example.test*app_backend_1',
      expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    });
    const revokeKey = jest.fn().mockResolvedValue({ confirmed: true });
    const bridge = { createKey, revokeKey } as unknown as CalendarBridgeClient;
    const credentials = new BridgeCalendarCredentials(bridge);

    await expect(credentials.resolve('workspace-1', mailbox)).resolves.toEqual({
      username: 'person@example.test*app_backend_1',
      password: 'runtime-secret',
    });
    await expect(credentials.resolve('workspace-1', mailbox)).resolves.toEqual({
      username: 'person@example.test*app_backend_1',
      password: 'runtime-secret',
    });
    expect(createKey).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, 'now').mockReturnValue(now + 56 * 60 * 1000);
    createKey.mockResolvedValueOnce({
      app_id: 'app_backend_2',
      secret: 'replacement-secret',
      username: 'person@example.test*app_backend_2',
      expires_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    });
    await expect(credentials.resolve('workspace-1', mailbox)).resolves.toEqual({
      username: 'person@example.test*app_backend_2',
      password: 'replacement-secret',
    });
    expect(createKey).toHaveBeenCalledTimes(2);

    await credentials.onModuleDestroy();
    expect(revokeKey).toHaveBeenCalledWith('app_backend_2');
  });

  it('fails closed when the bridge rejects a credential request', async () => {
    const bridge = {
      createKey: jest.fn().mockRejectedValue(new Error('credential must not escape')),
      revokeKey: jest.fn(),
    } as unknown as CalendarBridgeClient;
    const credentials = new BridgeCalendarCredentials(bridge);
    await expect(credentials.resolve('workspace-1', mailbox)).resolves.toBeNull();
  });
});
