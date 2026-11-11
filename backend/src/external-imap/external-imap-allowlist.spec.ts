import { NotFoundException } from '@nestjs/common';
import { ImapFlow, ImapFlowOptions } from 'imapflow';
import { MailboxAccount, User } from '@prisma/client';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import {
  credentials,
  FakeImapServer,
  fixturePassword,
  fixtureUsername,
} from '../../test/fake-imap.spec';
import { PrismaService } from '../prisma/prisma.service';
import { ExternalImapAccounts } from './external-imap.accounts';
import { ExternalImapController } from './external-imap.controller';
import { ExternalImapProvider } from './external-imap.provider';
import { ImapConnection } from './imap-connection';

class TestConnection extends ImapConnection {
  constructor(readonly server: FakeImapServer) {
    super();
  }
  protected createClient(options: ImapFlowOptions) {
    return new ImapFlow({ ...options, transport: this.server });
  }
}

describe('external IMAP per-workspace allowlist (#84)', () => {
  const previousFlag = process.env.EXTERNAL_IMAP_ENABLED;
  const previousWorkspaceIds = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
  const previousKey = process.env.CONNECTED_ACCOUNT_ENC_KEY;
  const user = { id: 'user-one', keycloakId: 'subject-one' } as User;
  const input = { ...credentials, email_address: 'reader@example.com' };
  let server: FakeImapServer;
  let connection: TestConnection;
  let accounts: ExternalImapAccounts;
  let provider: ExternalImapProvider;
  let controller: ExternalImapController;
  let mailbox: MailboxAccount;
  let row: any;
  let tx: any;
  let prisma: any;

  beforeEach(() => {
    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
    delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
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
    accounts = new ExternalImapAccounts(prisma as PrismaService, connection);
    provider = new ExternalImapProvider(accounts, connection);
    controller = new ExternalImapController(accounts, connection);
  });

  afterEach(() => {
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

  it('refuses a workspace off the allowlist with the global flag on: no connection is created or used', async () => {
    expect(controller.capabilities('workspace-two')).toEqual({ enabled: false });
    expect(() => controller.test('workspace-two', user, input)).toThrow(NotFoundException);
    await expect(accounts.test('workspace-two', input)).rejects.toThrow(NotFoundException);
    expect(() => controller.connect('workspace-two', user, input)).toThrow(NotFoundException);
    await expect(accounts.connect('workspace-two', user, input)).rejects.toThrow(NotFoundException);
    expect(
      await provider.listInbox(
        { ...mailbox, workspaceId: 'workspace-two' },
        {
          folder: 'inbox',
          limit: 10,
        },
      ),
    ).toMatchObject({ status: 'engine_not_configured', threads: [] });
    expect(await provider.getInboxCounts({ ...mailbox, workspaceId: 'workspace-two' })).toBeNull();
    expect(
      await provider.setThreadRead({ ...mailbox, workspaceId: 'workspace-two' }, 'imap-42-1', true),
    ).toBe(false);
    expect(
      await provider.downloadAttachment(
        { ...mailbox, workspaceId: 'workspace-two' },
        'imap-42-1',
        '2',
      ),
    ).toBeNull();
    expect(tx.mailboxAccount.create).not.toHaveBeenCalled();
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
    expect(row).toBeNull();
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(server.connections).toHaveLength(0);
  });

  it('lets an allowlisted workspace create and use a connection with the global flag on', async () => {
    expect(controller.capabilities('workspace-one')).toEqual({ enabled: true });
    expect(await controller.test('workspace-one', user, input)).toEqual({ status: 'ok' });
    expect(await controller.connect('workspace-one', user, input)).toEqual({
      status: 'ok',
      mailbox_id: mailbox.id,
    });
    expect(tx.mailboxAccount.create).toHaveBeenCalledTimes(1);
    expect(tx.externalImapAccount.upsert).toHaveBeenCalledTimes(1);
    expect(tx.externalImapAccount.upsert.mock.calls[0][0].create).toMatchObject({
      mailboxId: mailbox.id,
      host: 'imap.example.com',
      port: 993,
      username: fixtureUsername,
    });
    expect(tx.mailboxAccount.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: 'workspace-one',
      provider: 'external_imap',
      ownerKind: 'HUMAN',
    });
    expect(row.encryptedPassword.includes(fixturePassword)).toBe(false);
    expect(server.commands.some((s) => s.startsWith('SELECT INBOX'))).toBe(true);
    const stored = await accounts.credentials(mailbox);
    expect(stored).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      username: fixtureUsername,
      security: 'tls',
    });
    expect(stored.password).toBe(fixturePassword);
    expect(server.connections.length).toBeGreaterThan(0);
    const listed = await provider.listInbox(mailbox, { folder: 'inbox', limit: 10 });
    expect(listed.status).toBe('ok');
    expect(listed.threads.length).toBeGreaterThan(0);
    expect(await provider.getInboxCounts(mailbox)).toEqual({ inboxTotal: 3, inboxUnread: 3 });
  });

  it('still refuses an allowlisted workspace when the global flag is off', async () => {
    process.env.EXTERNAL_IMAP_ENABLED = 'false';
    expect(controller.capabilities('workspace-one')).toEqual({ enabled: false });
    expect(() => controller.test('workspace-one', user, input)).toThrow(NotFoundException);
    expect(() => controller.connect('workspace-one', user, input)).toThrow(NotFoundException);
    await expect(accounts.connect('workspace-one', user, input)).rejects.toThrow(NotFoundException);
    await expect(accounts.credentials(mailbox)).rejects.toThrow(NotFoundException);
    await expect(connection.test('workspace-one', credentials)).rejects.toThrow(NotFoundException);
    expect(await provider.listInbox(mailbox, { folder: 'inbox', limit: 10 })).toMatchObject({
      status: 'engine_not_configured',
      threads: [],
    });
    expect(tx.mailboxAccount.create).not.toHaveBeenCalled();
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
    expect(row).toBeNull();
    expect(server.connections).toHaveLength(0);
  });
});
