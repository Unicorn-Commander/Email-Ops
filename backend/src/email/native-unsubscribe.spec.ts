import {
  executeNativeUnsubscribeTargets,
  parseListUnsubscribe,
  parseMailto,
  resolveNativeUnsubscribeTargets,
  type NativeUnsubscribeTarget,
} from './native-unsubscribe';
import { NativeUnsubscribeHttpClient } from './native-unsubscribe-http';
import type {
  StalwartMessageDetail,
  StalwartSendRequest,
  StalwartSendResult,
} from '../stalwart/stalwart.types';

function detail(
  id: string,
  threadId: string,
  headers: Record<string, string>,
  overrides: Partial<StalwartMessageDetail> = {},
): StalwartMessageDetail {
  return {
    id,
    threadId,
    from: { address: 'news@example.test', name: 'News' },
    to: [{ address: 'desk@example.test', name: null }],
    subject: 'Newsletter',
    sentAt: '2026-10-18T01:00:00Z',
    preview: null,
    direction: 'received',
    cc: [],
    bcc: [],
    htmlBody: null,
    textBody: null,
    messageIdHeader: null,
    references: null,
    headers,
    isUnread: false,
    flagged: false,
    attachments: [],
    ...overrides,
  };
}

describe('native List-Unsubscribe parsing', () => {
  it('extracts RFC 2369 angle-bracket URIs and enables RFC 8058 one-click', () => {
    expect(
      parseListUnsubscribe({
        'List-Unsubscribe': '<https://example.test/u>, <mailto:leave@example.test?subject=bye>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }),
    ).toEqual({
      oneClickUrl: 'https://example.test/u',
      httpsUrls: ['https://example.test/u'],
      mailtos: ['mailto:leave@example.test?subject=bye'],
      oneClick: true,
    });
  });

  it('keeps comma-separated multiple URIs in header order', () => {
    expect(
      parseListUnsubscribe({
        'List-Unsubscribe':
          '<mailto:first@example.test>,<https://example.test/second>, <https://example.test/third>',
      }),
    ).toEqual({
      httpsUrls: ['https://example.test/second', 'https://example.test/third'],
      mailtos: ['mailto:first@example.test'],
      oneClick: false,
    });
  });

  it('matches the Post header case-insensitively', () => {
    expect(
      parseListUnsubscribe({
        'list-unsubscribe': '<https://example.test/u>',
        'LIST-UNSUBSCRIBE-POST': 'list-unsubscribe = one-click',
      }).oneClick,
    ).toBe(true);
  });

  it('does not turn junk into a guessed unsubscribe target', () => {
    expect(parseListUnsubscribe({ 'List-Unsubscribe': 'not a URI' })).toEqual({
      httpsUrls: [],
      mailtos: [],
      oneClick: false,
    });
    expect(parseListUnsubscribe({})).toEqual({
      httpsUrls: [],
      mailtos: [],
      oneClick: false,
    });
  });
});

describe('native unsubscribe target resolution and execution', () => {
  it('uses mocked James details and skips a thread with no List-Unsubscribe header', async () => {
    const james = new Map<string, StalwartMessageDetail[]>([
      [
        'one',
        [
          detail('m-one', 'one', {
            'List-Unsubscribe': '<https://example.test/u>',
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          }),
        ],
      ],
      [
        'two',
        [
          detail('m-two', 'two', {
            'List-Unsubscribe':
              '<https://example.test/browser>, <mailto:leave@example.test?subject=bye>',
          }),
        ],
      ],
      ['three', [detail('m-three', 'three', {})]],
    ]);
    const result = await resolveNativeUnsubscribeTargets(
      [{ emailAddress: 'desk@example.test' }],
      ['one', 'two', 'three'],
      async (_mailbox, threadId) => james.get(threadId) ?? [],
      'User asked to unsubscribe from these newsletters.',
    );

    expect(result.targets).toMatchObject([
      { thread_id: 'one', one_click_url: 'https://example.test/u', mailbox: 'desk@example.test' },
      { thread_id: 'two', mailto: 'mailto:leave@example.test?subject=bye' },
    ]);
    expect(result.skipped).toEqual([
      { thread_id: 'three', reason: 'no List-Unsubscribe header; nothing staged' },
    ]);
  });

  it('POSTs one-click without a sender and counts a 3xx as success', async () => {
    const http = {
      postOneClick: jest
        .fn()
        .mockResolvedValue({ accepted: true, status: 302, detail: 'redirect accepted' }),
    };
    const send = jest.fn<Promise<StalwartSendResult>, [string, StalwartSendRequest, boolean]>();
    const target: NativeUnsubscribeTarget = {
      thread_id: 'one',
      message_id: 'm-one',
      mailbox: 'desk@example.test',
      sender: 'News <news@example.test>',
      subject: 'Newsletter',
      one_click_url: 'https://example.test/u',
      rationale: 'test',
    };

    const result = await executeNativeUnsubscribeTargets([target], http, send);

    expect(result).toMatchObject({ completed: 1, failed: 0, total_attempted: 1 });
    expect(result.unsubscribe_results[0]).toMatchObject({
      thread_id: 'one',
      status: 'unsubscribed',
      method: 'one_click',
    });
    expect(http.postOneClick).toHaveBeenCalledWith('https://example.test/u');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a minimal mailto from the same native mailbox and records failure per thread', async () => {
    const http = { postOneClick: jest.fn() };
    const send = jest
      .fn<Promise<StalwartSendResult>, [string, StalwartSendRequest, boolean]>()
      .mockResolvedValueOnce({
        accepted: true,
        providerMessageId: 'sent-1',
        threadId: null,
        lane: 'james',
      })
      .mockResolvedValueOnce({
        accepted: false,
        providerMessageId: null,
        threadId: null,
        lane: 'james',
        reason: 'James rejected the send',
      });
    const targets: NativeUnsubscribeTarget[] = [
      {
        thread_id: 'two',
        message_id: 'm-two',
        mailbox: 'desk@example.test',
        sender: 'News <news@example.test>',
        subject: 'Newsletter',
        mailto: 'mailto:leave%40example.test?subject=bye%20now',
        rationale: 'test',
      },
      {
        thread_id: 'three',
        message_id: 'm-three',
        mailbox: 'desk@example.test',
        sender: null,
        subject: 'Other',
        mailto: 'mailto:leave@example.test',
        rationale: 'test',
      },
    ];

    const result = await executeNativeUnsubscribeTargets(targets, http, send);

    expect(send).toHaveBeenNthCalledWith(
      1,
      'desk@example.test',
      expect.objectContaining({
        fromAddress: 'desk@example.test',
        toAddress: 'leave@example.test',
        subject: 'bye now',
        body: 'Please unsubscribe me.',
      }),
      false,
    );
    expect(result).toMatchObject({ completed: 1, failed: 1, total_attempted: 2 });
    expect(result.unsubscribe_results.map((row) => row.status)).toEqual(['unsubscribed', 'failed']);
  });

  it('uses the cleaner-engine mailto defaults', () => {
    expect(parseMailto('mailto:leave@example.test')).toEqual({
      to: 'leave@example.test',
      subject: 'unsubscribe',
      body: 'Please unsubscribe me.',
    });
  });
});

describe('NativeUnsubscribeHttpClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses an HTTPS form POST and never follows redirects', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ status: 302 });
    global.fetch = fetchSpy as unknown as typeof fetch;
    const client = new NativeUnsubscribeHttpClient({ get: () => undefined } as any);

    await expect(client.postOneClick('https://example.test/u')).resolves.toMatchObject({
      accepted: true,
      status: 302,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.test/u',
      expect.objectContaining({
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
      }),
    );
  });

  it('rejects a non-HTTPS one-click URL without fetching it', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const client = new NativeUnsubscribeHttpClient({ get: () => undefined } as any);

    await expect(client.postOneClick('http://example.test/u')).resolves.toMatchObject({
      accepted: false,
      detail: 'one-click URL is not HTTPS',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
