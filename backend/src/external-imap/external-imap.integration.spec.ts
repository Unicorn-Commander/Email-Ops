import { FakeSmtpServer } from '../../test/fake-smtp.spec';
import { ImapFlow, ImapFlowOptions } from 'imapflow';
import { Logger, NotFoundException } from '@nestjs/common';
import { MailboxAccount, User } from '@prisma/client';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import {
  FakeImapServer,
  credentials,
  fixturePassword,
  fixtureUsername,
} from '../../test/fake-imap.spec';
import { PrismaService } from '../prisma/prisma.service';
import { decrypt } from '../connected-accounts/crypto';
import { EngineMailProvider } from '../mail-provider/engine-mail-provider';
import { RoutingMailProvider } from '../mail-provider/routing-mail-provider';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { ExternalImapAccounts } from './external-imap.accounts';
import { ExternalImapController } from './external-imap.controller';
import { ExternalImapProvider } from './external-imap.provider';
import { ImapConnection, publicAddress } from './imap-connection';

class TestConnection extends ImapConnection {
  options: ImapFlowOptions[] = [];
  constructor(readonly server: FakeImapServer) {
    super();
  }
  protected createClient(options: ImapFlowOptions) {
    this.options.push(options);
    return new ImapFlow({ ...options, transport: this.server });
  }
}

describe('external IMAP protocol integration (no sockets or database)', () => {
  const previousWorkspaceIds = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
  const previousSendFlag = process.env.EXTERNAL_IMAP_SEND_ENABLED;
  let smtp: FakeSmtpServer;
  const previousFlag = process.env.EXTERNAL_IMAP_ENABLED;
  const previousKey = process.env.CONNECTED_ACCOUNT_ENC_KEY;
  let server: FakeImapServer;
  let connection: TestConnection;
  let accounts: ExternalImapAccounts;
  let provider: ExternalImapProvider;
  let mailbox: MailboxAccount;
  let row: any;
  let tx: any;
  let prisma: any;
  let logs: string[];
  const user = { id: 'user-one', keycloakId: 'subject-one' } as User;
  const noSecrets = (value: unknown) => {
    const serialized = JSON.stringify(value);
    expect(serialized.includes(fixturePassword)).toBe(false);
    expect(serialized.includes(fixtureUsername)).toBe(false);
  };

  beforeEach(() => {
    delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
    process.env.CONNECTED_ACCOUNT_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
    // Any accidental real transport is a test failure, not a network call.
    jest.spyOn(net, 'connect').mockImplementation(() => {
      throw new Error('Network forbidden');
    });
    jest.spyOn(tls, 'connect').mockImplementation(() => {
      throw new Error('Network forbidden');
    });
    jest.spyOn(dns, 'lookup').mockImplementation(() => {
      throw new Error('DNS forbidden');
    });
    logs = [];
    for (const stream of [process.stdout, process.stderr]) {
      jest.spyOn(stream, 'write').mockImplementation((chunk: any, encoding?: any, done?: any) => {
        logs.push(String(chunk));
        if (typeof encoding === 'function') encoding();
        if (typeof done === 'function') done();
        return true;
      });
    }
    for (const method of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args) => {
        logs.push(JSON.stringify(args));
      });
      jest.spyOn(Logger.prototype, method).mockImplementation((...args) => {
        logs.push(JSON.stringify(args));
      });
    }
    server = new FakeImapServer();
    connection = new TestConnection(server);
    mailbox = {
      id: 'mailbox-one',
      workspaceId: 'workspace-one',
      ownerKind: 'HUMAN',
      ownerKey: 'subject-one',
      provider: 'external_imap',
      active: true,
      emailAddress: 'reader@example.com',
    } as MailboxAccount;
    row = null;
    tx = {
      mailboxAccount: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(mailbox),
      },
      externalImapAccount: {
        upsert: jest.fn(async ({ create, update }) => {
          row = row ? { ...row, ...update } : create;
          return row;
        }),
        findFirst: jest.fn(async () => row),
      },
    };
    prisma = { withWorkspace: jest.fn((_workspace, _user, fn) => fn(tx)) };
    smtp = new FakeSmtpServer();
    accounts = new ExternalImapAccounts(prisma as PrismaService, connection, smtp);
    provider = new ExternalImapProvider(accounts, connection, smtp);
  });

  afterEach(() => {
    noSecrets(logs);
    for (const socket of smtp.sockets) expect(socket.destroyed).toBe(true);
    if (previousSendFlag === undefined) delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    else process.env.EXTERNAL_IMAP_SEND_ENABLED = previousSendFlag;
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
    for (const socket of server.sockets) expect(socket.destroyed).toBe(true);
    jest.restoreAllMocks();
    if (previousWorkspaceIds === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = previousWorkspaceIds;
    if (previousFlag === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = previousFlag;
    if (previousKey === undefined) delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    else process.env.CONNECTED_ACCOUNT_ENC_KEY = previousKey;
  });

  async function register() {
    const result = await accounts.connect('workspace-one', user, {
      ...credentials,
      email_address: 'reader@example.com',
    });
    expect(result.status).toBe('ok');
    noSecrets(result);
    expect(row.encryptedPassword.includes(fixturePassword)).toBe(false);
    expect(decrypt<{ password: string }>(row.encryptedPassword).password === fixturePassword).toBe(
      true,
    );
  }

  it('LOGIN and SELECT INBOX, then encrypts and saves only a personal non-sending account', async () => {
    await register();
    expect(server.commands).toContain('LOGIN [redacted]');
    expect(server.commands.some((s) => s.startsWith('SELECT INBOX'))).toBe(true);
    expect(tx.mailboxAccount.create.mock.calls[0][0].data).toMatchObject({
      provider: 'external_imap',
      ownerKind: 'HUMAN',
      ownerKey: 'subject-one',
      isDefault: false,
      postmarkLane: false,
    });
    expect(connection.options[0]).toMatchObject({
      port: 993,
      secure: true,
      disableAutoIdle: true,
      logger: false,
      emitLogs: false,
      logRaw: false,
      tls: {
        family: 4,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        servername: 'imap.example.com',
      },
    });
  });

  it('validates the DNS address passed to the TLS socket without a second lookup', async () => {
    await register();
    const socketLookup = connection.options[0].tls!.lookup!;
    const callback = jest.fn();
    jest.mocked(dns.lookup).mockImplementationOnce((...args: any[]) => {
      const done = args[2];
      done(null, '127.0.0.1', 4);
    });
    socketLookup('imap.example.com', { family: 4 }, callback);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(callback.mock.calls[0][1]).toBe('');
    callback.mockClear();
    jest.mocked(dns.lookup).mockImplementationOnce((...args: any[]) => {
      const done = args[2];
      done(null, '203.0.113.1', 4);
    });
    socketLookup('imap.example.com', { family: 4 }, callback);
    expect(callback).toHaveBeenCalledWith(null, '203.0.113.1', 4);
    expect(dns.lookup).toHaveBeenCalledTimes(2);
  });

  it('lists grouped threads, pages them, reads bodies without attachment bytes, downloads on demand and marks seen', async () => {
    await register();
    const first = await provider.listInbox(mailbox, { folder: 'inbox', limit: 1 });
    expect(first.status).toBe('ok');
    expect(first.threads).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = await provider.listInbox(mailbox, {
      folder: 'inbox',
      limit: 1,
      pageToken: first.nextPageToken,
    });
    expect(second.hasMore).toBe(false);
    expect(second.threads[0].message_count).toBe(2);
    expect(second.threads[0].unread).toBe(true);
    const threadId = second.threads[0].id;
    const detail = await provider.listThreadMessages(mailbox, threadId);
    expect(detail.status).toBe('ok');
    expect(detail.messages.map((m) => m.text_body)).toEqual(['Hello inbox!', 'Hello inbox!']);
    expect(detail.messages[0].attachments?.[0]).toMatchObject({
      blob_id: 'imap-42-1::2',
      name: 'note.txt',
      type: 'application/octet-stream',
    });
    expect(server.commands.some((s) => /BODY\.PEEK\[2\]/.test(s))).toBe(false);
    expect(server.seen.size).toBe(0);
    const attachment = await provider.downloadAttachment(mailbox, detail.messages[0].id, '2');
    expect(attachment?.data.toString()).toBe('hello');
    expect(await provider.setThreadRead(mailbox, threadId, true)).toBe(true);
    expect([...server.seen]).toEqual([1, 2]);
    const reread = await provider.listInbox(mailbox, { folder: 'inbox', limit: 50 });
    expect(reread.threads.find((t) => t.id === threadId)?.unread).toBe(false);
    expect(await provider.getInboxCounts(mailbox)).toEqual({ inboxTotal: 3, inboxUnread: 1 });
    expect(await provider.setThreadRead(mailbox, threadId, false)).toBe(true);
    expect(server.seen.size).toBe(0);
    expect(server.commands.some((s) => /^(IDLE|STARTTLS|APPEND|EXPUNGE|DELETE|MOVE)/.test(s))).toBe(
      false,
    );
    // Credentials lookup is fenced by both the caller's mailbox and workspace.
    expect(tx.externalImapAccount.findFirst.mock.calls[0][0].where).toMatchObject({
      mailboxId: mailbox.id,
      mailbox: { workspaceId: mailbox.workspaceId, ownerKey: mailbox.ownerKey },
    });
  });

  it('returns typed authentication failure without leaking hostile server text or saving anything', async () => {
    const result = await accounts.connect('workspace-one', user, {
      ...credentials,
      password: 'incorrect',
      email_address: 'reader@example.com',
    });
    expect(result).toEqual({ status: 'auth_failed' });
    noSecrets(result);
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
    expect(server.commands.some((s) => s.startsWith('SELECT'))).toBe(false);
  });

  it.each(['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'])(
    'maps %s to tls_failed',
    async (code) => {
      server.failureCode = code;
      const result = await connection.test('workspace-one', credentials);
      expect(result).toEqual({ status: 'tls_failed' });
      noSecrets(result);
    },
  );

  it('maps unreachable and SELECT refusal to a sanitized result', async () => {
    server.failureCode = 'ECONNREFUSED';
    expect(await connection.test('workspace-one', credentials)).toEqual({ status: 'unreachable' });
    server.failureCode = null;
    server.refuseInbox = true;
    expect(await connection.test('workspace-one', credentials)).toEqual({ status: 'unreachable' });
  });

  it('bounds a silent server and closes the request session', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      server.silent = true;
      const pending = connection.test('workspace-one', credentials);
      await jest.advanceTimersByTimeAsync(20001);
      expect(await pending).toEqual({ status: 'unreachable' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('enables only the listed workspace for capabilities and connection routes', async () => {
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = ' workspace-two, , workspace-one, workspace-one ';
    const controller = new ExternalImapController(accounts, connection);
    expect(controller.capabilities('workspace-one')).toEqual({ enabled: true });
    expect(controller.capabilities('workspace-three')).toEqual({ enabled: false });
    const input = { ...credentials, email_address: 'reader@example.com' };
    expect(await controller.test('workspace-one', user, input)).toEqual({ status: 'ok' });
    expect(await controller.connect('workspace-one', user, input)).toEqual({
      status: 'ok',
      mailbox_id: mailbox.id,
    });
    const count = server.connections.length;
    prisma.withWorkspace.mockClear();
    expect(
      await provider.listInbox(
        { ...mailbox, workspaceId: 'workspace-three' },
        {
          folder: 'inbox',
          limit: 10,
        },
      ),
    ).toMatchObject({ status: 'engine_not_configured', threads: [] });
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(server.connections).toHaveLength(count);
  });

  it('requires a human session for connection management', () => {
    const controller = new ExternalImapController(accounts, connection);
    expect(() =>
      controller.connect('workspace-one', { ...user, __patAuth: {} } as User, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).toThrow('signed-in session');
    expect(server.connections).toHaveLength(0);
  });

  it.each([{ port: 143 }, { port: 587 }, { security: 'plaintext' }, { security: 'starttls' }])(
    'refuses insecure options before connecting',
    async (override) => {
      const result = await connection.test('workspace-one', {
        ...credentials,
        ...override,
      } as typeof credentials);
      expect(result).toEqual({ status: 'tls_failed' });
      expect(server.connections).toHaveLength(0);
    },
  );

  it.each([
    [undefined, 'workspace-one'],
    ['false', 'workspace-one'],
    ['true', 'workspace-two'],
    ['true', ''],
    ['true', undefined],
    ['true', ' , , '],
  ])('refuses every IMAP entry point with flag %s and allowlist %s', async (flag, ids) => {
    const controller = new ExternalImapController(accounts, connection);
    if (flag === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = flag;
    if (ids === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = ids;
    expect(controller.capabilities('workspace-one')).toEqual({ enabled: false });
    expect(() =>
      controller.test('workspace-one', user, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).toThrow(NotFoundException);
    await expect(
      accounts.connect('workspace-one', user, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(() =>
      controller.connect('workspace-one', user, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).toThrow(NotFoundException);
    await expect(accounts.credentials(mailbox)).rejects.toThrow(NotFoundException);
    await expect(connection.test('workspace-one', credentials)).rejects.toThrow(NotFoundException);
    const operation = jest.fn();
    await expect(connection.run('workspace-one', credentials, operation)).rejects.toThrow(
      NotFoundException,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(await provider.listThreadMessages(mailbox, 'imap-42-1')).toEqual({
      messages: [],
      status: 'engine_not_configured',
    });
    expect(await provider.getInboxCounts(mailbox)).toBeNull();
    expect(await provider.downloadAttachment(mailbox, 'imap-42-1', '2')).toBeNull();
    expect(await provider.setThreadRead(mailbox, 'imap-42-1', true)).toBe(false);
    const engine = {
      handles: jest.fn(() => true),
      send: jest.fn(),
      listInbox: jest.fn(),
    } as unknown as EngineMailProvider;
    const router = new RoutingMailProvider(engine, provider);
    expect(router.handles(mailbox)).toBe(true);
    expect(await router.listInbox(mailbox, { folder: 'inbox', limit: 10 })).toMatchObject({
      status: 'engine_not_configured',
      threads: [],
    });
    expect(
      await router.send(mailbox, {
        from: 'reader@example.com',
        to: 'other@example.com',
        subject: '',
        body: '',
      }),
    ).toMatchObject({ accepted: false, reason: 'Sending from this mailbox is not available yet.' });
    expect(engine.send).not.toHaveBeenCalled();
    expect(engine.listInbox).not.toHaveBeenCalled();
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(server.connections).toHaveLength(0);
  });

  it('refuses all non-seen writes and watcher/draft operations without connecting', async () => {
    const port: MailProviderPort = provider;
    expect(await port.send(mailbox, { from: '', to: '', subject: '', body: '' })).toMatchObject({
      accepted: false,
    });
    expect(
      await port.createDraft(mailbox, { from: '', to: '', subject: '', body: '' }),
    ).toMatchObject({ created: false });
    expect(await port.deleteDraft(mailbox, 'draft')).toBe(false);
    expect(await port.archiveThread(mailbox, 'thread')).toBe(false);
    expect(await port.trashThread(mailbox, 'thread')).toBe(false);
    expect(await port.spamThread(mailbox, 'thread')).toBe(false);
    expect(await port.restoreThreadToInbox(mailbox, 'thread')).toBe(false);
    expect(await port.setThreadFlagged(mailbox, 'thread', true)).toBe(false);
    expect(await port.pollInbound(mailbox, null)).toBeNull();
    expect(server.connections).toHaveLength(0);
  });

  it('does not overwrite another owner or existing hosted/send identity', async () => {
    for (const existing of [
      { ...mailbox, ownerKey: 'another-owner' },
      { ...mailbox, provider: 'james' },
      { ...mailbox, ownerKind: 'SHARED' },
    ]) {
      tx.mailboxAccount.findUnique.mockResolvedValue(existing);
      await expect(
        accounts.connect('workspace-one', user, {
          ...credentials,
          email_address: 'reader@example.com',
        }),
      ).rejects.toThrow('already registered');
    }
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
  });

  it('sanitizes persistence failures and rejects missing encryption before login', async () => {
    tx.externalImapAccount.upsert.mockRejectedValue(
      new Error(`${fixtureUsername} ${fixturePassword}`),
    );
    await expect(
      accounts.connect('workspace-one', user, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).rejects.toThrow('Could not save');
    delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    const count = server.connections.length;
    await expect(
      accounts.connect('workspace-one', user, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).rejects.toThrow('encryption');
    expect(server.connections).toHaveLength(count);
  });

  it('distinguishes an empty inbox, stale UIDVALIDITY, missing attachment, and unsupported search', async () => {
    await register();
    server.empty = true;
    expect(await provider.listInbox(mailbox, { folder: 'inbox', limit: 10 })).toMatchObject({
      status: 'ok',
      threads: [],
    });
    server.empty = false;
    expect(await provider.downloadAttachment(mailbox, 'imap-41-1', '2')).toBeNull();
    expect(await provider.downloadAttachment(mailbox, 'imap-42-1', '99')).toBeNull();
    expect(
      await provider.listInbox(mailbox, {
        folder: 'inbox',
        limit: 10,
        query: 'from:sender@example.com',
      }),
    ).toMatchObject({ threads: [], searchSupported: false });
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
  ])('rejects internal destination %s', (address) => {
    expect(publicAddress(address)).toBe(false);
  });
  const smtpSettings = { host: 'smtp.example.com', port: 587 as const };
  const message = {
    from: 'spoof@example.com',
    to: 'recipient@example.com',
    subject: 'Re: Plans',
    body: 'A reply',
    sendAuthorization: 'approval' as const,
  };
  async function registerSmtp(port: 465 | 587 = 587) {
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    const result = await accounts.connect('workspace-one', user, {
      ...credentials,
      email_address: mailbox.emailAddress,
      smtp: { ...smtpSettings, port },
    });
    expect(result).toEqual({ status: 'ok', mailbox_id: mailbox.id });
    noSecrets(result);
  }

  it.each([465, 587] as const)(
    'tests SMTP AUTH on %s without submitting mail and reuses encrypted IMAP credentials',
    async (port) => {
      await registerSmtp(port);
      expect(smtp.commands.some((s) => s.startsWith('AUTH'))).toBe(true);
      expect(smtp.commands.some((s) => /^(MAIL|RCPT|DATA)/.test(s))).toBe(false);
      expect(smtp.commands.includes('STARTTLS')).toBe(port === 587);
      expect(
        smtp.options.every(
          (options) =>
            options.rejectUnauthorized === true &&
            options.minVersion === 'TLSv1.2' &&
            options.servername === 'smtp.example.com',
        ),
      ).toBe(true);
      expect(row.smtpEncryptedPassword).toBeNull();
      expect(row.smtpUsername).toBeNull();
      const stored = await accounts.credentials(mailbox);
      expect(stored.smtp?.password === fixturePassword).toBe(true);
      expect(stored.smtp?.username === fixtureUsername).toBe(true);
    },
  );

  it('encrypts a separate SMTP password and preserves settings on IMAP-only reconnect', async () => {
    await registerSmtp();
    await accounts.connect('workspace-one', user, {
      ...credentials,
      email_address: mailbox.emailAddress,
      smtp: { ...smtpSettings, username: 'smtp-user@example.com', password: fixturePassword },
    });
    expect(row.smtpEncryptedPassword.includes(fixturePassword)).toBe(false);
    expect(
      decrypt<{ password: string }>(row.smtpEncryptedPassword).password === fixturePassword,
    ).toBe(true);
    await register();
    expect((await accounts.credentials(mailbox)).smtp?.username).toBe('smtp-user@example.com');
  });

  it.each(['missing', 'refused', 'certificate'] as const)(
    'refuses STARTTLS %s before AUTH or saving',
    async (kind) => {
      process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
      smtp.starttls = kind !== 'missing';
      smtp.refuseUpgrade = kind === 'refused';
      smtp.failCertificate = kind === 'certificate';
      const result = await accounts.connect('workspace-one', user, {
        ...credentials,
        email_address: mailbox.emailAddress,
        smtp: smtpSettings,
      });
      expect(result).toEqual({ status: 'tls_failed' });
      expect(smtp.commands.some((s) => s.startsWith('AUTH'))).toBe(false);
      expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
      noSecrets(result);
    },
  );

  it('returns a typed wrong SMTP password without server text, logs or persistence', async () => {
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    smtp.wrongPassword = true;
    const result = await accounts.connect('workspace-one', user, {
      ...credentials,
      email_address: mailbox.emailAddress,
      smtp: smtpSettings,
    });
    expect(result).toEqual({ status: 'auth_failed' });
    noSecrets(result);
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
  });

  it('replies using phase-one thread grouping, sends all recipients and APPENDs identical MIME to SPECIAL-USE Sent', async () => {
    await registerSmtp();
    const inbox = await provider.listInbox(mailbox, { folder: 'inbox', limit: 10 });
    const threadId = inbox.threads.find((t) => t.message_count === 2)!.id;
    const result = await provider.send(mailbox, {
      ...message,
      inReplyToThreadId: threadId,
      toAddresses: ['recipient@example.com', 'second@example.com'],
      cc: ['copy@example.com'],
      bcc: ['hidden@example.com'],
      bodyHtml: '<p>A reply</p>',
      attachments: [
        {
          filename: 'note.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('attachment').toString('base64'),
        },
      ],
    });
    expect(result).toMatchObject({ accepted: true, threadId, reason: null });
    const raw = smtp.messages[0].toString();
    expect(raw).toContain('From: reader@example.com\r\n');
    expect(raw).not.toContain('spoof@example.com');
    expect(raw).not.toContain('hidden@example.com');
    expect(raw).toContain('In-Reply-To: <two@example.com>\r\n');
    expect(raw).toContain('References: <one@example.com>\r\n <two@example.com>');
    expect(raw).toContain(`Message-ID: ${result.providerMessageId}`);
    expect(raw).toMatch(/^Date: .+GMT\r$/m);
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('YXR0YWNobWVudA==');
    expect(smtp.commands).toEqual(
      expect.arrayContaining([
        'MAIL FROM:<reader@example.com>',
        ...['recipient', 'second', 'copy', 'hidden'].map((name) => `RCPT TO:<${name}@example.com>`),
      ]),
    );
    expect(server.appended).toHaveLength(1);
    expect(server.appended[0].folder).toBe('Sent Items');
    expect(server.appended[0].raw.equals(smtp.messages[0])).toBe(true);
    noSecrets(result);
  });

  it('falls back to Sent and supports AUTH LOGIN', async () => {
    smtp.authMethod = 'LOGIN';
    server.sentFolder = null;
    await registerSmtp(465);
    expect(await provider.send(mailbox, { ...message, sendAuthorization: 'human' })).toMatchObject({
      accepted: true,
    });
    expect(server.appended[0].folder).toBe('Sent');
  });

  it('does not invite a duplicate SMTP delivery when Sent APPEND fails', async () => {
    await registerSmtp();
    server.refuseAppend = true;
    expect(await provider.send(mailbox, message)).toMatchObject({
      accepted: true,
      reason: 'Message sent, but the Sent copy could not be saved.',
    });
    expect(smtp.messages).toHaveLength(1);
  });

  it('refuses stale replies, header injection and a rejected recipient before DATA', async () => {
    await registerSmtp();
    for (const override of [
      { inReplyToThreadId: 'imap-41-missing' },
      { to: 'recipient@example.com\r\nBcc: hidden@example.com' },
    ]) {
      expect(await provider.send(mailbox, { ...message, ...override })).toMatchObject({
        accepted: false,
      });
    }
    smtp.refuseRecipient = true;
    expect(await provider.send(mailbox, message)).toMatchObject({ accepted: false });
    expect(smtp.messages).toHaveLength(0);
    expect(server.appended).toHaveLength(0);
  });

  it('blocks unattended sends and either disabled flag before credential or network access', async () => {
    await registerSmtp();
    const count = server.connections.length;
    const smtpCount = smtp.sockets.length;
    prisma.withWorkspace.mockClear();
    expect(
      await provider.send(mailbox, { ...message, sendAuthorization: undefined }),
    ).toMatchObject({ accepted: false, reason: 'A human send or approval is required.' });
    for (const [imapFlag, sendFlag] of [
      ['true', 'false'],
      ['false', 'true'],
      ['true', 'TRUE'],
    ]) {
      process.env.EXTERNAL_IMAP_ENABLED = imapFlag;
      process.env.EXTERNAL_IMAP_SEND_ENABLED = sendFlag;
      expect(await provider.send(mailbox, message)).toMatchObject({
        accepted: false,
        reason: 'Sending from this mailbox is not available yet.',
      });
    }
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(server.connections).toHaveLength(count);
    expect(smtp.sockets).toHaveLength(smtpCount);
  });

  it.each(['human', 'approval'] as const)(
    'refuses an unlisted workspace despite %s authorization',
    async (sendAuthorization) => {
      await registerSmtp();
      process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-two';
      const imapConnections = server.connections.length;
      const smtpConnections = smtp.sockets.length;
      prisma.withWorkspace.mockClear();
      expect(await provider.send(mailbox, { ...message, sendAuthorization })).toMatchObject({
        accepted: false,
        reason: 'Sending from this mailbox is not available yet.',
      });
      expect(prisma.withWorkspace).not.toHaveBeenCalled();
      expect(server.connections).toHaveLength(imapConnections);
      expect(smtp.sockets).toHaveLength(smtpConnections);
      expect(smtp.messages).toHaveLength(0);
      expect(server.appended).toHaveLength(0);
    },
  );

  it('rechecks workspace eligibility at SMTP transport after preparing an approved reply', async () => {
    await registerSmtp();
    const run = connection.run.bind(connection);
    jest.spyOn(connection, 'run').mockImplementationOnce(async (workspaceId, creds, operation) => {
      const prepared = await run(workspaceId, creds, operation);
      process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-two';
      return prepared;
    });
    const smtpConnections = smtp.sockets.length;
    expect(await provider.send(mailbox, message)).toMatchObject({ accepted: false });
    expect(smtp.sockets).toHaveLength(smtpConnections);
    expect(smtp.messages).toHaveLength(0);
    expect(server.appended).toHaveLength(0);
  });

  it('blocks SMTP setup and AUTH tests for an unlisted workspace', async () => {
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    const body = { ...credentials, email_address: mailbox.emailAddress, smtp: smtpSettings };
    await expect(accounts.connect('workspace-two', user, body)).rejects.toThrow(NotFoundException);
    await expect(accounts.test('workspace-two', body)).rejects.toThrow(NotFoundException);
    await expect(smtp.test('workspace-two', { ...credentials, ...smtpSettings })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(server.connections).toHaveLength(0);
    expect(smtp.sockets).toHaveLength(0);
  });

  it('keeps SMTP configuration inaccessible with flag off or PAT auth', async () => {
    const controller = new ExternalImapController(accounts, connection);
    const body = { ...credentials, email_address: mailbox.emailAddress, smtp: smtpSettings };
    expect(controller.capabilities('workspace-one')).toEqual({ enabled: true });
    await expect(controller.test('workspace-one', user, body)).rejects.toThrow(NotFoundException);
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    for (const action of [
      () => controller.test('workspace-one', { ...user, __patAuth: {} } as User, body),
      () => controller.connect('workspace-one', { ...user, __patAuth: {} } as User, body),
    ])
      expect(action).toThrow('signed-in session');
    expect(server.connections).toHaveLength(0);
    expect(smtp.sockets).toHaveLength(0);
  });

  it('applies the same DNS guard to the actual SMTP socket lookup', async () => {
    await registerSmtp();
    const callback = jest.fn();
    jest
      .mocked(dns.lookup)
      .mockImplementationOnce((...args: any[]) => args[2](null, '127.0.0.1', 4));
    smtp.options[0].lookup!('smtp.example.com', {}, callback);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(Error);
    jest
      .mocked(dns.lookup)
      .mockImplementationOnce((...args: any[]) => args[2](null, '203.0.113.1', 4));
    smtp.options[0].lookup!('smtp.example.com', {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, '203.0.113.1', 4);
  });

  it('closes a silent SMTP server at the total deadline', async () => {
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    smtp.silent = true;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const result = smtp.test('workspace-one', {
        ...smtpSettings,
        username: fixtureUsername,
        password: fixturePassword,
      });
      await jest.advanceTimersByTimeAsync(20001);
      expect(await result).toEqual({ status: 'unreachable' });
    } finally {
      jest.useRealTimers();
    }
  });
});
