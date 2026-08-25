import { MailboxAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
import { EngineMailProvider } from './engine-mail-provider';

/**
 * EngineMailProvider: prove the external-provider chain (resolve the owning User
 * → KC broker token → credentials → cleaner-engine) maps results to the wire
 * shapes, picks the right alias/credentials per provider, and degrades clean
 * (no owner / no user / no token / dormant engine → [] or accepted:false).
 */
function gmailbox(over: Partial<MailboxAccount> = {}): MailboxAccount {
  return {
    id: 'mb-1',
    workspaceId: 'ws-1',
    emailAddress: 'person84@example.com',
    displayName: 'Me',
    provider: 'gmail',
    ownerKind: 'HUMAN',
    ownerKey: 'kc-sub-1',
    kind: 'gmail',
    ...over,
  } as MailboxAccount;
}

function make(opts: {
  token?: string | null;
  user?: { keycloakId: string } | null;
  threads?: unknown;
  thread?: unknown;
  send?: unknown;
  profile?: unknown;
  archive?: unknown;
  trash?: unknown;
  spam?: unknown;
  restore?: unknown;
  readSet?: unknown;
  flagSet?: unknown;
  stats?: unknown;
  attachment?: unknown;
}) {
  const broker = {
    getProviderAccessToken: jest.fn().mockResolvedValue(opts.token ?? null),
  } as unknown as KeycloakBrokerService;
  const engine = {
    getAccountProfile: jest.fn().mockResolvedValue(opts.profile ?? null),
    listMailThreads: jest.fn().mockResolvedValue(opts.threads ?? null),
    getMailThread: jest.fn().mockResolvedValue(opts.thread ?? null),
    sendMail: jest.fn().mockResolvedValue(opts.send ?? null),
    archiveMailThread: jest.fn().mockResolvedValue(opts.archive ?? null),
    trashMailThread: jest.fn().mockResolvedValue(opts.trash ?? null),
    spamMailThread: jest.fn().mockResolvedValue(opts.spam ?? null),
    restoreMailThreadToInbox: jest.fn().mockResolvedValue(opts.restore ?? null),
    setMailThreadRead: jest.fn().mockResolvedValue(opts.readSet ?? null),
    flagMailThread: jest.fn().mockResolvedValue(opts.flagSet ?? null),
    getInboxStats: jest.fn().mockResolvedValue(opts.stats ?? null),
    getMailAttachment: jest.fn().mockResolvedValue(opts.attachment ?? null),
  } as unknown as ConnectedAccountsEnginePort;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(opts.user ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.user ?? null),
    },
  } as unknown as PrismaService;
  return { provider: new EngineMailProvider(engine, broker, prisma), broker, engine, prisma };
}

describe('EngineMailProvider', () => {
  it('handles external providers only', () => {
    const { provider } = make({});
    expect(provider.handles({ provider: 'gmail' })).toBe(true);
    expect(provider.handles({ provider: 'microsoft' })).toBe(true);
    expect(provider.handles({ provider: 'stalwart' })).toBe(false);
  });

  it('listInbox: resolves user → google alias → engine, maps threads to ThreadView', async () => {
    const { provider, broker, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      threads: {
        threads: [
          {
            id: 't1',
            subject: 'Hi',
            participants: [{ address: 'a@x.test', name: 'A' }],
            last_message_at: '2026-06-24T00:00:00Z',
            last_snippet: 'hello',
            message_count: 2,
            unread: true,
          },
        ],
      },
    });
    const out = await provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 });
    expect(broker.getProviderAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ keycloakId: 'kc-sub-1' }),
      'google',
    );
    expect(engine.listMailThreads).toHaveBeenCalledWith(
      'gmail',
      { token: 'gtok' },
      'inbox',
      50,
      null,
      null,
    );
    expect(out.threads).toEqual([
      {
        id: 't1',
        subject: 'Hi',
        message_count: 2,
        unread: true,
        // read-back defaults to unstarred when the engine omits `flagged`
        flagged: false,
        last_message_at: '2026-06-24T00:00:00Z',
        last_snippet: 'hello',
        participants: [{ address: 'a@x.test', name: 'A' }],
      },
    ]);
    expect(out.hasMore).toBe(false);
    expect(out.nextPageToken).toBeNull();
  });

  it('microsoft uses the microsoft alias + access_token credentials', async () => {
    const { provider, broker, engine } = make({ user: { keycloakId: 'kc-sub-1' }, token: 'mtok', threads: { threads: [] } });
    await provider.listInbox(gmailbox({ provider: 'microsoft', kind: 'microsoft' }), {
      folder: 'spam',
      limit: 25,
    });
    expect(broker.getProviderAccessToken).toHaveBeenCalledWith(expect.anything(), 'microsoft');
    expect(engine.listMailThreads).toHaveBeenCalledWith(
      'microsoft',
      { access_token: 'mtok' },
      'spam',
      25,
      null,
      null,
    );
  });

  it('listInbox maps search operators to Gmail q and threads pageToken honestly', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      threads: {
        threads: [{ id: 't2', subject: 'Promo', participants: [], last_message_at: null, last_snippet: null, message_count: 1, unread: false }],
        next_page_token: 'PAGE_2',
        has_more: true,
      },
    });
    const out = await provider.listInbox(gmailbox(), {
      folder: 'inbox',
      limit: 10,
      query: 'from:promo@shop.com has:attachment after:2024-01-01',
      pageToken: 'PAGE_1',
    });
    expect(engine.listMailThreads).toHaveBeenCalledWith(
      'gmail',
      { token: 'gtok' },
      'inbox',
      10,
      'from:promo@shop.com has:attachment after:2024-01-01',
      'PAGE_1',
    );
    expect(out.nextPageToken).toBe('PAGE_2');
    expect(out.hasMore).toBe(true);
    expect(out.threads).toHaveLength(1);
  });

  it('microsoft receives the RAW query (NOT Gmail-mapped) so its own parser can honour or reject it', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'mtok',
      threads: { threads: [] },
    });
    await provider.listInbox(gmailbox({ provider: 'microsoft', kind: 'microsoft' }), {
      folder: 'inbox',
      limit: 10,
      query: 'is:flagged',
    });
    // The raw operator query must reach the Microsoft provider untouched — a
    // Gmail-mangled string would stop it raising the honest "not supported".
    expect(engine.listMailThreads).toHaveBeenCalledWith(
      'microsoft',
      { access_token: 'mtok' },
      'inbox',
      10,
      'is:flagged',
      null,
    );
  });

  it('listInbox refuses numeric offset without pageToken (honest no-more-pages)', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      threads: { threads: [{ id: 'should-not-return' }] },
    });
    const out = await provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50, offset: 50 });
    expect(engine.listMailThreads).not.toHaveBeenCalled();
    expect(out.threads).toEqual([]);
    expect(out.hasMore).toBe(false);
    expect(out.nextPageToken).toBeNull();
    expect(out.reason).toMatch(/page_token/i);
  });

  it('listInbox degrades clean: no owner / no user / no token / null engine → empty page', async () => {
    const empty = {
      threads: [],
      nextPageToken: null,
      hasMore: false,
      searchSupported: true,
      reason: null,
    };
    expect(await make({}).provider.listInbox(gmailbox({ ownerKey: null }), { folder: 'inbox', limit: 50 })).toEqual(empty);
    expect(await make({ user: null }).provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 })).toEqual(empty);
    expect(
      await make({ user: { keycloakId: 'kc-sub-1' }, token: null }).provider.listInbox(gmailbox(), {
        folder: 'inbox',
        limit: 50,
      }),
    ).toEqual(empty);
    expect(
      await make({ user: { keycloakId: 'kc-sub-1' }, token: 'gtok', threads: null }).provider.listInbox(
        gmailbox(),
        { folder: 'inbox', limit: 50 },
      ),
    ).toEqual(empty);
  });

  it('send: maps an accepted engine result; not-connected → accepted:false (engine never called)', async () => {
    const happy = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      send: { accepted: true, provider_message_id: 'pm-1', thread_id: 't9', reason: null },
    });
    const ok = await happy.provider.send(gmailbox(), { from: 'person84@example.com', to: 'x@y.test', subject: 's', body: 'b' });
    expect(ok).toEqual({ accepted: true, providerMessageId: 'pm-1', threadId: 't9', reason: null });

    const notConnected = make({ user: { keycloakId: 'kc-sub-1' }, token: null });
    const res = await notConnected.provider.send(gmailbox(), { from: 'person84@example.com', to: 'x@y.test', subject: 's', body: 'b' });
    expect(res).toEqual({ accepted: false, providerMessageId: null, threadId: null, reason: 'account_not_connected' });
    expect(notConnected.engine.sendMail).not.toHaveBeenCalled();
  });

  it('archiveThread: routes through the engine triage verb; ok:true → true', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      archive: { ok: true, moved: 3 },
    });
    expect(await provider.archiveThread(gmailbox(), 't1')).toBe(true);
    expect(engine.archiveMailThread).toHaveBeenCalledWith('gmail', { token: 'gtok' }, 't1');
  });

  it('trashThread: ok:true → true; not-connected → false without touching the engine', async () => {
    const happy = make({ user: { keycloakId: 'kc-sub-1' }, token: 'gtok', trash: { ok: true, moved: 2 } });
    expect(await happy.provider.trashThread(gmailbox(), 't1')).toBe(true);
    expect(happy.engine.trashMailThread).toHaveBeenCalledWith('gmail', { token: 'gtok' }, 't1');

    const notConnected = make({ user: { keycloakId: 'kc-sub-1' }, token: null });
    expect(await notConnected.provider.trashThread(gmailbox(), 't1')).toBe(false);
    expect(notConnected.engine.trashMailThread).not.toHaveBeenCalled();
  });

  it('spamThread: routes through the engine triage verb; ok:true → true', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      spam: { ok: true, moved: 2 },
    });
    expect(await provider.spamThread(gmailbox(), 't1')).toBe(true);
    expect(engine.spamMailThread).toHaveBeenCalledWith('gmail', { token: 'gtok' }, 't1');
  });

  it('restoreThreadToInbox: ok:true → true; not-connected → false without touching the engine', async () => {
    const happy = make({ user: { keycloakId: 'kc-sub-1' }, token: 'gtok', restore: { ok: true, moved: 2 } });
    expect(await happy.provider.restoreThreadToInbox(gmailbox(), 't1')).toBe(true);
    expect(happy.engine.restoreMailThreadToInbox).toHaveBeenCalledWith('gmail', { token: 'gtok' }, 't1');

    const notConnected = make({ user: { keycloakId: 'kc-sub-1' }, token: null });
    expect(await notConnected.provider.restoreThreadToInbox(gmailbox(), 't1')).toBe(false);
    expect(notConnected.engine.restoreMailThreadToInbox).not.toHaveBeenCalled();
  });

  it('setThreadRead: forwards the read flag (microsoft credentials shape) and maps ok', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'mtok',
      readSet: { ok: true, moved: 4 },
    });
    expect(
      await provider.setThreadRead(gmailbox({ provider: 'microsoft', kind: 'microsoft' }), 't1', false),
    ).toBe(true);
    expect(engine.setMailThreadRead).toHaveBeenCalledWith(
      'microsoft',
      { access_token: 'mtok' },
      't1',
      false,
    );
  });

  it('triage verbs degrade clean: dormant engine (null) or engine ok:false → false', async () => {
    const base = { user: { keycloakId: 'kc-sub-1' }, token: 'gtok' };
    expect(await make({ ...base, archive: null }).provider.archiveThread(gmailbox(), 't1')).toBe(false);
    expect(await make({ ...base, trash: { ok: false, moved: 0 } }).provider.trashThread(gmailbox(), 't1')).toBe(false);
    expect(await make({ ...base, spam: null }).provider.spamThread(gmailbox(), 't1')).toBe(false);
    expect(await make({ ...base, restore: { ok: false, moved: 0 } }).provider.restoreThreadToInbox(gmailbox(), 't1')).toBe(false);
    expect(await make({ ...base, readSet: { ok: false, moved: 0 } }).provider.setThreadRead(gmailbox(), 't1', true)).toBe(false);
  });

  it('resolveOwnAddress returns the provider-authoritative address, lowercased', async () => {
    const { provider, engine } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      profile: { email: 'Real.person84@example.com' },
    });
    expect(await provider.resolveOwnAddress('gmail', 'kc-sub-1')).toBe('real.person84@example.com');
    expect(engine.getAccountProfile).toHaveBeenCalledWith('gmail', { token: 'gtok' });
  });

  it('resolveOwnAddress degrades clean: no token / no profile / blank email → null', async () => {
    expect(await make({ user: { keycloakId: 'k' }, token: null }).provider.resolveOwnAddress('gmail', 'k')).toBeNull();
    expect(
      await make({ user: { keycloakId: 'k' }, token: 'gtok', profile: null }).provider.resolveOwnAddress('gmail', 'k'),
    ).toBeNull();
    expect(
      await make({ user: { keycloakId: 'k' }, token: 'gtok', profile: { email: '  ' } }).provider.resolveOwnAddress(
        'gmail',
        'k',
      ),
    ).toBeNull();
  });

  it('setThreadFlagged: forwards to the engine flag route and maps ok', async () => {
    const { provider, engine } = make({ user: { keycloakId: 'kc-sub-1' }, token: 'gtok', flagSet: { ok: true } });
    expect(await provider.setThreadFlagged(gmailbox(), 't1', true)).toBe(true);
    expect(engine.flagMailThread).toHaveBeenCalledWith('gmail', { token: 'gtok' }, 't1', true);
  });

  it('setThreadFlagged degrades clean to false when not connected', async () => {
    const { provider } = make({ user: { keycloakId: 'kc-sub-1' }, token: null, flagSet: { ok: true } });
    expect(await provider.setThreadFlagged(gmailbox(), 't1', true)).toBe(false);
  });

  it('listInbox reads flagged back so a starred thread shows starred', async () => {
    const { provider } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      threads: { threads: [{ id: 't1', subject: 'S', participants: [], last_message_at: null, last_snippet: null, message_count: 1, unread: false, flagged: true }] },
    });
    const out = await provider.listInbox(gmailbox(), { folder: 'inbox', limit: 50 });
    expect(out.threads[0].flagged).toBe(true);
  });

  it('getInboxCounts: maps engine stats to inbox unread/total', async () => {
    const { provider } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      stats: { total_messages: 42, unread_count: 7 },
    });
    expect(await provider.getInboxCounts(gmailbox())).toEqual({ inboxUnread: 7, inboxTotal: 42 });
  });

  it('getInboxCounts degrades clean to null (no token / no stats)', async () => {
    expect(await make({ user: { keycloakId: 'k' }, token: null }).provider.getInboxCounts(gmailbox())).toBeNull();
    expect(
      await make({ user: { keycloakId: 'k' }, token: 'gtok', stats: null }).provider.getInboxCounts(gmailbox()),
    ).toBeNull();
  });

  it('listThreadMessages maps attachments to composite blob_ids', async () => {
    const { provider } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      thread: {
        messages: [
          {
            id: 'm1',
            thread_id: 't1',
            from: null,
            to: [],
            subject: 'S',
            sent_at: null,
            preview: 'p',
            direction: 'received',
            attachments: [{ id: 'att9', filename: 'doc.pdf', mime_type: 'application/pdf', size: 1234, cid: null }],
          },
        ],
      },
    });
    const out = await provider.listThreadMessages(gmailbox(), 't1');
    expect(out[0].attachments).toEqual([
      { blob_id: 'm1::att9', name: 'doc.pdf', type: 'application/pdf', size: 1234, cid: null },
    ]);
  });

  it('downloadAttachment: decodes engine base64 bytes', async () => {
    const { provider } = make({
      user: { keycloakId: 'kc-sub-1' },
      token: 'gtok',
      attachment: { found: true, content_base64: Buffer.from('hello').toString('base64'), mime_type: 'text/plain', filename: 'a.txt' },
    });
    const res = await provider.downloadAttachment(gmailbox(), 'm1', 'att9');
    expect(res?.data.toString('utf8')).toBe('hello');
    expect(res?.contentType).toBe('text/plain');
  });

  it('downloadAttachment degrades clean to null (not found / no token)', async () => {
    expect(
      await make({ user: { keycloakId: 'k' }, token: 'gtok', attachment: { found: false } }).provider.downloadAttachment(gmailbox(), 'm', 'a'),
    ).toBeNull();
    expect(
      await make({ user: { keycloakId: 'k' }, token: null }).provider.downloadAttachment(gmailbox(), 'm', 'a'),
    ).toBeNull();
  });
});
