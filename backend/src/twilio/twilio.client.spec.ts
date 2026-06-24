import { ConfigService } from '@nestjs/config';
import { TwilioClient } from './twilio.client';

function client(env: Record<string, string | undefined>): TwilioClient {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new TwilioClient(config);
}

describe('TwilioClient (SMS engine)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('dormant (no TWILIO_* creds) — degrade-clean', () => {
    const c = client({});

    it('isConfigured() is false', () => {
      expect(c.isConfigured()).toBe(false);
    });

    it('send() returns not-configured WITHOUT any network call', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(
        c.send({ fromPhoneNumber: '+15550001111', toPhoneNumber: '+15552223333', body: 'hi' }),
      ).resolves.toMatchObject({ accepted: false, reason: 'not-configured', lane: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('configured', () => {
    const env = {
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: 'tok-secret',
      TWILIO_API_BASE_URL: 'https://api.example',
    };

    it('isConfigured() is true', () => {
      expect(client(env).isConfigured()).toBe(true);
    });

    it('rejects an invalid request (empty body) without a network call', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(
        client(env).send({ fromPhoneNumber: '+1', toPhoneNumber: '+2', body: '' }),
      ).resolves.toMatchObject({ accepted: false, reason: 'invalid request' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('accepted send POSTs form-encoded to the Messages endpoint and returns the sid', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ sid: 'SM123' }),
      } as unknown as Response);

      const r = await client(env).send({
        fromPhoneNumber: '+15550001111',
        toPhoneNumber: '+15552223333',
        body: 'hello',
      });

      expect(r).toMatchObject({ accepted: true, providerMessageId: 'SM123', lane: 'twilio' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example/2010-04-01/Accounts/ACtest/Messages.json');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(headers.Authorization).toMatch(/^Basic /);
      expect(String(init.body)).toContain('Body=hello');
      expect(String(init.body)).toContain('To=%2B15552223333');
    });

    it('an HTTP error degrades clean (accepted=false, never throws)', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'bad request',
      } as unknown as Response);

      await expect(
        client(env).send({ fromPhoneNumber: '+1', toPhoneNumber: '+2', body: 'x' }),
      ).resolves.toMatchObject({ accepted: false, lane: 'twilio', reason: 'http 400' });
    });

    it('a transport error degrades clean (accepted=false, never throws)', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(
        client(env).send({ fromPhoneNumber: '+1', toPhoneNumber: '+2', body: 'x' }),
      ).resolves.toMatchObject({ accepted: false, lane: 'twilio', reason: 'ECONNREFUSED' });
    });
  });
});
