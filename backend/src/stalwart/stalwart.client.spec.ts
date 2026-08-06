import { ConfigService } from '@nestjs/config';
import { StalwartClient } from './stalwart.client';

/**
 * StalwartClient is the degrade-clean mail-engine adapter. The load-bearing
 * guarantee: with the STALWART_* config unset, it is fully dormant — reads
 * return [] and sends return accepted:false (lane=null) WITHOUT any network
 * call, and nothing throws. When configured, the read path hits JMAP and the
 * transactional send routes Postmark.
 */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (k: string) => env[k] } as unknown as ConfigService;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('StalwartClient', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
    jest.restoreAllMocks();
  });

  describe('degrade-clean: STALWART_* unset (dormant)', () => {
    const client = new StalwartClient(makeConfig({}));

    it('isConfigured() is false', () => {
      expect(client.isConfigured()).toBe(false);
    });

    it('listThreads / listMessages return [] WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listThreads('desk@x.test', 'jane@acme.test')).resolves.toEqual([]);
      await expect(client.listMessages('desk@x.test', 'thread-1')).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('send returns accepted:false (lane=null) WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      const r = await client.send(
        'desk@x.test',
        { fromAddress: 'desk@x.test', toAddress: 'jane@acme.test', subject: 's', body: 'b' },
        true,
      );
      expect(r.accepted).toBe(false);
      expect(r.lane).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('webmail-wave additions: NOT SUPPORTED on the legacy engine (degrade-clean, never throw)', () => {
    const client = new StalwartClient(makeConfig({}));

    it('listFolderThreads / getThreadDetail / setThreadRead / getMailboxCounts / downloadBlob / uploadBlob all degrade clean WITHOUT any fetch', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as any;
      await expect(client.listFolderThreads('desk@x.test', { folder: 'inbox', limit: 10, offset: 0 })).resolves.toEqual({
        threads: [],
      });
      await expect(client.getThreadDetail('desk@x.test', 'thread-1')).resolves.toEqual([]);
      await expect(client.setThreadRead('desk@x.test', 'thread-1', true)).resolves.toBe(false);
      await expect(client.getMailboxCounts('desk@x.test')).resolves.toBeNull();
      await expect(client.downloadBlob('desk@x.test', 'blob-1')).resolves.toBeNull();
      await expect(client.uploadBlob('desk@x.test', Buffer.from('x'), 'text/plain', 'f.txt')).resolves.toBeNull();
      await expect(client.getMessageHeaders('desk@x.test', 'msg-1')).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('configured: JMAP read + Postmark transactional send', () => {
    const CONFIGURED = {
      STALWART_JMAP_URL: 'https://mail.example.test/jmap/',
      STALWART_JMAP_TOKEN: 'jmap-token',
      POSTMARK_SERVER_TOKEN: 'pm-token',
    };

    it('isConfigured() is true', () => {
      expect(new StalwartClient(makeConfig(CONFIGURED)).isConfigured()).toBe(true);
    });

    it('listThreads posts JMAP and maps the threads projection', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(
        jsonResponse({
          methodResponses: [
            [
              'Email/query',
              {
                threads: [
                  {
                    id: 'thread-1',
                    subject: 'Proposal',
                    messageCount: 2,
                    unread: true,
                    lastMessageAt: '2026-06-02T10:00:00Z',
                    lastSnippet: 'hi',
                    participants: [{ email: 'jane@acme.test', name: 'Jane' }],
                  },
                ],
              },
              '0',
            ],
          ],
        }),
      );
      global.fetch = fetchSpy as any;
      const client = new StalwartClient(makeConfig(CONFIGURED));
      const threads = await client.listThreads('desk@x.test', 'jane@acme.test');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://mail.example.test/jmap');
      expect(init.headers['Authorization']).toBe('Bearer jmap-token');
      expect(threads[0]).toMatchObject({
        id: 'thread-1',
        subject: 'Proposal',
        messageCount: 2,
        unread: true,
      });
      expect(threads[0].participants).toEqual([{ address: 'jane@acme.test', name: 'Jane' }]);
    });

    it('transactional send routes to the Postmark API and maps the MessageID', async () => {
      const fetchSpy = jest.fn().mockResolvedValue(jsonResponse({ MessageID: 'pm-123' }));
      global.fetch = fetchSpy as any;
      const client = new StalwartClient(makeConfig(CONFIGURED));
      const r = await client.send(
        'desk@x.test',
        { fromAddress: 'desk@x.test', fromName: 'Desk', toAddress: 'jane@acme.test', subject: 's', body: 'b' },
        true,
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.postmarkapp.com/email');
      expect(fetchSpy.mock.calls[0][1].headers['X-Postmark-Server-Token']).toBe('pm-token');
      expect(r).toMatchObject({ accepted: true, lane: 'postmark', providerMessageId: 'pm-123' });
    });

    it('reads return [] (never throw) on a transport error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
      const client = new StalwartClient(makeConfig(CONFIGURED));
      await expect(client.listThreads('m', 'a')).resolves.toEqual([]);
      await expect(client.listMessages('m', 't')).resolves.toEqual([]);
    });
  });
});
