import { User } from '@prisma/client';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { ConnectedAccountsService } from './connected-accounts.service';

describe('ConnectedAccountsService', () => {
  const user = { id: 'u1', email: 'user@example.test' } as User;

  const broker = {
    getProviderAccessToken: jest.fn(),
  } as unknown as KeycloakBrokerService;

  const engine = {
    isConfigured: jest.fn().mockReturnValue(true),
    getInboxStats: jest.fn(),
    analyzeInbox: jest.fn(),
  } as unknown as ConnectedAccountsEnginePort;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function service() {
    return new ConnectedAccountsService(broker, engine);
  }

  it('lists linked providers without leaking credentials', async () => {
    (broker.getProviderAccessToken as jest.Mock)
      .mockResolvedValueOnce('google-token')
      .mockResolvedValueOnce(null);

    const res = await service().listConnectedAccounts(user);
    expect(res).toEqual({
      accounts: [
        { provider: 'gmail', linked: true },
        { provider: 'microsoft', linked: false },
      ],
    });
  });

  it('passes gmail tokens to the engine as { token }', async () => {
    (broker.getProviderAccessToken as jest.Mock).mockResolvedValue('gmail-access-token');
    (engine.getInboxStats as jest.Mock).mockResolvedValue({
      total_messages: 1,
      total_threads: 1,
      unread_count: 0,
      promotional_count: 0,
      social_count: 0,
      storage_used_bytes: 12,
    });

    const res = await service().getInboxStats(user, 'gmail');
    expect(engine.getInboxStats).toHaveBeenCalledWith('gmail', { token: 'gmail-access-token' });
    expect(res).toEqual({
      available: true,
      provider: 'gmail',
      stats: expect.objectContaining({ total_messages: 1 }),
    });
  });

  it('passes microsoft tokens to the engine as { access_token }', async () => {
    (broker.getProviderAccessToken as jest.Mock).mockResolvedValue('ms-access-token');
    (engine.analyzeInbox as jest.Mock).mockResolvedValue({ summary: 'ok' });

    const res = await service().analyzeInbox(user, 'microsoft');
    expect(engine.analyzeInbox).toHaveBeenCalledWith('microsoft', {
      access_token: 'ms-access-token',
    });
    expect(res).toEqual({
      available: true,
      provider: 'microsoft',
      analysis: { summary: 'ok' },
    });
  });

  it('returns a structured unavailable result when no broker token exists', async () => {
    (broker.getProviderAccessToken as jest.Mock).mockResolvedValue(null);

    await expect(service().getInboxStats(user, 'gmail')).resolves.toEqual({
      available: false,
      provider: 'gmail',
      reason: 'no linked gmail account — sign in via gmail first',
    });
    expect(engine.getInboxStats).not.toHaveBeenCalled();
  });
});
