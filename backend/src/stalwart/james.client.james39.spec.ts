import { ConfigService } from '@nestjs/config';
import { JamesClient } from './james.client';

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const CONFIGURED = {
  JAMES_JMAP_URL: 'https://james.example.test/jmap/',
  JAMES_JMAP_BASIC: 'hq@unicorncommander.ai:secret',
};

const SESSION = {
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-hq' },
  accounts: { 'acct-hq': { name: 'hq@unicorncommander.ai' } },
};

const THREAD_ID = 'em-no-message-id';
const THREAD_EMAIL = {
  id: THREAD_ID,
  threadId: THREAD_ID,
  from: [{ email: 'sender@outside.test' }],
  to: [{ email: 'hq@unicorncommander.ai' }],
  subject: 'No Message-ID',
  receivedAt: '2026-10-20T20:36:41.000Z',
  preview: 'Original text',
  keywords: { $seen: true },
  textBody: [{ partId: 'text' }],
  bodyValues: { text: { value: 'Original text' } },
};

function methodCalls(init: RequestInit): any[] {
  return JSON.parse(init.body as string).methodCalls;
}

function mockSendFetch(mailboxes: any[]) {
  const queryRoles: string[] = [];
  const mailboxGetCalls: any[][] = [];
  const fetchSpy = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return jsonResponse(SESSION);
    const calls = methodCalls(init!);
    const methods = calls.map((call) => call[0]);
    if (methods.includes('Identity/get')) {
      return jsonResponse({
        methodResponses: [['Identity/get', { list: [{ id: 'identity-1', email: 'hq@unicorncommander.ai' }] }, '0']],
      });
    }
    if (methods.includes('Mailbox/query')) {
      const query = calls.find((call) => call[0] === 'Mailbox/query')[1];
      const role = query.filter.role as string;
      queryRoles.push(role);
      return jsonResponse({
        methodResponses: [
          ['Mailbox/query', { type: 'invalidArguments', description: `${role} is not a valid role` }, '0'],
        ],
      });
    }
    if (methods.includes('Mailbox/get')) {
      mailboxGetCalls.push(calls);
      return jsonResponse({ methodResponses: [['Mailbox/get', { list: mailboxes }, '0']] });
    }
    if (methods.includes('EmailSubmission/set')) {
      return jsonResponse({
        methodResponses: [
          ['Email/set', { created: { outbound: { id: 'email-1', threadId: 'thread-1' } } }, '0'],
          ['EmailSubmission/set', { created: { submission: { id: 'submission-1' } } }, '1'],
        ],
      });
    }
    return jsonResponse({ methodResponses: [] });
  });
  return { fetchSpy, queryRoles, mailboxGetCalls };
}

function mockThreadFallbackFetch() {
  return jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return jsonResponse(SESSION);
    const calls = methodCalls(init!);
    const methods = calls.map((call) => call[0]);
    if (methods.includes('Mailbox/query')) {
      return jsonResponse({ methodResponses: [['Mailbox/query', { ids: ['mbx-archive'] }, '0']] });
    }
    if (methods.includes('Mailbox/get')) {
      return jsonResponse({ methodResponses: [['Mailbox/get', { list: [{ id: 'mbx-target' }] }, '0']] });
    }
    if (methods.includes('Thread/get')) {
      const methodResponses: any[] = [['Thread/get', { notFound: [THREAD_ID] }, '0']];
      if (methods.includes('Email/get')) {
        methodResponses.push(['Email/get', { notFound: [THREAD_ID] }, '1']);
      }
      return jsonResponse({ methodResponses });
    }
    if (methods.includes('Email/get')) {
      return jsonResponse({ methodResponses: [['Email/get', { list: [THREAD_EMAIL] }, '0']] });
    }
    if (methods.includes('Email/set')) {
      return jsonResponse({ methodResponses: [['Email/set', { updated: { [THREAD_ID]: null } }, '0']] });
    }
    return jsonResponse({ methodResponses: [] });
  });
}

describe('JamesClient James 3.9 compatibility', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('resolves Sent and Drafts through Mailbox/get after James rejects those role queries', async () => {
    const { fetchSpy, queryRoles, mailboxGetCalls } = mockSendFetch([
      { id: 'mbx-sent', name: 'Outgoing', role: 'SeNt' },
      { id: 'mbx-drafts', name: 'Working', role: 'DRAFTS' },
      { id: 'mbx-inbox', name: 'Inbox', role: 'INBOX' },
    ]);
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    const result = await client.send(
      'hq@unicorncommander.ai',
      {
        fromAddress: 'hq@unicorncommander.ai',
        toAddress: 'recipient@example.test',
        subject: 'James roles',
        body: 'body',
      },
      false,
    );

    expect(result).toMatchObject({ accepted: true, providerMessageId: 'email-1' });
    expect(queryRoles).toEqual(['sent', 'drafts']);
    expect(mailboxGetCalls).toHaveLength(2);

    const submissionBody = fetchSpy.mock.calls
      .filter(([, init]) => Boolean((init as RequestInit | undefined)?.body))
      .map(([, init]) => methodCalls(init as RequestInit))
      .find((calls) => calls.some((call) => call[0] === 'EmailSubmission/set'))!;
    const emailSet = submissionBody.find((call) => call[0] === 'Email/set')[1];
    expect(emailSet.create.outbound.mailboxIds).toEqual({ 'mbx-drafts': true });
    expect(emailSet.create.outbound.keywords).toEqual({ $draft: true, $seen: true });
    const submissionSet = submissionBody.find((call) => call[0] === 'EmailSubmission/set')[1];
    expect(submissionSet.onSuccessUpdateEmail['#sub']).toEqual({
      'keywords/$draft': null,
      'mailboxIds/mbx-drafts': null,
      'mailboxIds/mbx-sent': true,
    });
  });

  it('uses Sent Items and Drafts names only when Mailbox/get has no matching roles', async () => {
    const { fetchSpy } = mockSendFetch([
      { id: 'mbx-sent-name', name: 'sENT iTEMS', role: null },
      { id: 'mbx-drafts-name', name: 'dRaFtS', role: null },
    ]);
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(
      client.send(
        'hq@unicorncommander.ai',
        {
          fromAddress: 'hq@unicorncommander.ai',
          toAddress: 'recipient@example.test',
          subject: 'Named roles',
          body: 'body',
        },
        false,
      ),
    ).resolves.toMatchObject({ accepted: true });

    const submissionBody = fetchSpy.mock.calls
      .filter(([, init]) => Boolean((init as RequestInit | undefined)?.body))
      .map(([, init]) => methodCalls(init as RequestInit))
      .find((calls) => calls.some((call) => call[0] === 'EmailSubmission/set'))!;
    expect(submissionBody.find((call) => call[0] === 'Email/set')[1].create.outbound.mailboxIds).toEqual({
      'mbx-drafts-name': true,
    });
    expect(submissionBody.find((call) => call[0] === 'EmailSubmission/set')[1].onSuccessUpdateEmail['#sub']).toMatchObject({
      'mailboxIds/mbx-sent-name': true,
    });
  });

  it('gets thread detail by message id when Thread/get reports notFound', async () => {
    const fetchSpy = mockThreadFallbackFetch();
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(client.getThreadDetail('hq@unicorncommander.ai', THREAD_ID)).resolves.toMatchObject([
      { id: THREAD_ID, threadId: THREAD_ID, subject: 'No Message-ID', textBody: 'Original text' },
    ]);
  });

  it('lists a message by id when Thread/get reports notFound', async () => {
    const fetchSpy = mockThreadFallbackFetch();
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(client.listMessages('hq@unicorncommander.ai', THREAD_ID)).resolves.toMatchObject([
      { id: THREAD_ID, threadId: THREAD_ID, subject: 'No Message-ID' },
    ]);
  });

  it('sets read state on the message id when Thread/get reports notFound', async () => {
    const fetchSpy = mockThreadFallbackFetch();
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(client.setThreadRead('hq@unicorncommander.ai', THREAD_ID, false)).resolves.toBe(true);
    const emailSet = fetchSpy.mock.calls
      .map(([, init]) => (init as RequestInit | undefined)?.body)
      .filter(Boolean)
      .map((body) => methodCalls({ body } as RequestInit))
      .flatMap((calls) => calls)
      .find((call) => call[0] === 'Email/set');
    expect(emailSet[1].update).toEqual({ [THREAD_ID]: { 'keywords/$seen': false } });
  });

  it('moves a message by id to a role folder when Thread/get reports notFound', async () => {
    const fetchSpy = mockThreadFallbackFetch();
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(client.moveThreadToFolder('hq@unicorncommander.ai', THREAD_ID, 'archive')).resolves.toBe(true);
    const emailSet = fetchSpy.mock.calls
      .map(([, init]) => (init as RequestInit | undefined)?.body)
      .filter(Boolean)
      .map((body) => methodCalls({ body } as RequestInit))
      .flatMap((calls) => calls)
      .find((call) => call[0] === 'Email/set');
    expect(emailSet[1].update).toEqual({ [THREAD_ID]: { mailboxIds: { 'mbx-archive': true } } });
  });

  it('moves a message by id to a custom folder when Thread/get reports notFound', async () => {
    const fetchSpy = mockThreadFallbackFetch();
    global.fetch = fetchSpy as any;
    const client = new JamesClient(makeConfig(CONFIGURED));

    await expect(client.moveThreadToMailbox('hq@unicorncommander.ai', THREAD_ID, 'mbx-target')).resolves.toBe(true);
    const emailSet = fetchSpy.mock.calls
      .map(([, init]) => (init as RequestInit | undefined)?.body)
      .filter(Boolean)
      .map((body) => methodCalls({ body } as RequestInit))
      .flatMap((calls) => calls)
      .find((call) => call[0] === 'Email/set');
    expect(emailSet[1].update).toEqual({ [THREAD_ID]: { mailboxIds: { 'mbx-target': true } } });
  });
});
