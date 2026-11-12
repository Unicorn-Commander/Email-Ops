import { Logger, NotFoundException } from '@nestjs/common';
import { MailboxAccount, User } from '@prisma/client';
import { ImapFlow, ImapFlowOptions } from 'imapflow';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { FakeImapServer, credentials, fixturePassword } from '../../test/fake-imap.spec';
import { PrismaService } from '../prisma/prisma.service';
import { ExternalImapAccounts } from './external-imap.accounts';
import { ExternalImapController } from './external-imap.controller';
import { ExternalImapProvider } from './external-imap.provider';
import { ImapConnection } from './imap-connection';

class FixtureConnection extends ImapConnection {
  constructor(private readonly server: FakeImapServer) {
    super();
  }

  protected createClient(options: ImapFlowOptions) {
    return new ImapFlow({ ...options, transport: this.server });
  }
}

describe('external IMAP connect to disconnect over the wire fixture', () => {
  const originalFlag = process.env.EXTERNAL_IMAP_ENABLED;
  const originalWorkspaces = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
  const originalKey = process.env.CONNECTED_ACCOUNT_ENC_KEY;
  const user = { id: 'reader-one', keycloakId: 'reader-subject' } as User;
  const mailbox = {
    id: 'mailbox-one',
    workspaceId: 'workspace-one',
    ownerKind: 'HUMAN',
    ownerKey: 'reader-subject',
    provider: 'external_imap',
    active: true,
    emailAddress: 'reader@example.com',
  } as MailboxAccount;

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = originalFlag;
    if (originalWorkspaces === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = originalWorkspaces;
    if (originalKey === undefined) delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    else process.env.CONNECTED_ACCOUNT_ENC_KEY = originalKey;
    jest.restoreAllMocks();
  });

  it('refuses disabled and bad credentials, lists three threads, then wipes the credential', async () => {
    process.env.EXTERNAL_IMAP_ENABLED = 'false';
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
    process.env.CONNECTED_ACCOUNT_ENC_KEY = Buffer.alloc(32, 11).toString('base64');
    const server = new FakeImapServer();
    server.independentThreads = true;
    const connection = new FixtureConnection(server);
    let stored: { encryptedPassword: string; host: string; port: number; username: string } | null =
      null;
    const tx = {
      mailboxAccount: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(mailbox),
        create: jest.fn().mockResolvedValue(mailbox),
        update: jest.fn(async ({ data }: { data: { active: boolean } }) => {
          mailbox.active = data.active;
          return mailbox;
        }),
      },
      externalImapAccount: {
        upsert: jest.fn(async ({ create }: { create: typeof stored }) => {
          stored = create;
          return stored;
        }),
        findFirst: jest.fn(async () => stored),
        deleteMany: jest.fn(async () => {
          const count = stored ? 1 : 0;
          stored = null;
          return { count };
        }),
      },
    };
    const prisma = { withWorkspace: jest.fn((_workspace, _owner, fn) => fn(tx)) };
    const accounts = new ExternalImapAccounts(prisma as unknown as PrismaService, connection);
    const controller = new ExternalImapController(accounts, connection);
    const provider = new ExternalImapProvider(accounts, connection);
    const input = { ...credentials, email_address: mailbox.emailAddress };
    const logs: string[] = [];
    for (const method of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, method).mockImplementation((...args) => logs.push(JSON.stringify(args)));
      jest
        .spyOn(Logger.prototype, method)
        .mockImplementation((...args) => logs.push(JSON.stringify(args)));
    }
    for (const stream of [process.stdout, process.stderr]) {
      jest.spyOn(stream, 'write').mockImplementation((chunk: any, encoding?: any, done?: any) => {
        logs.push(String(chunk));
        if (typeof encoding === 'function') encoding();
        if (typeof done === 'function') done();
        return true;
      });
    }
    jest.spyOn(net, 'connect').mockImplementation(() => {
      throw new Error('Network forbidden');
    });
    jest.spyOn(tls, 'connect').mockImplementation(() => {
      throw new Error('Network forbidden');
    });
    jest.spyOn(dns, 'lookup').mockImplementation(() => {
      throw new Error('DNS forbidden');
    });

    expect(controller.capabilities('workspace-one')).toEqual({ enabled: false });
    expect(() => controller.connect('workspace-one', user, input)).toThrow(NotFoundException);
    expect(server.connections).toHaveLength(0);

    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    const wrongPassword = 'wrong-fixture-password';
    const rejected = await controller.connect('workspace-one', user, {
      ...input,
      password: wrongPassword,
    });
    expect(rejected).toEqual({ status: 'auth_failed' });
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();

    expect(await controller.connect('workspace-one', user, input)).toEqual({
      status: 'ok',
      mailbox_id: mailbox.id,
    });
    expect(stored).not.toBeNull();
    expect(stored!.encryptedPassword).not.toContain(fixturePassword);
    const search = await connection.run('workspace-one', credentials, (client) =>
      client.search({ all: true }, { uid: true }),
    );
    expect(server.commands).toContain('UID SEARCH ALL');
    expect(search).toEqual([1, 2, 3]);
    const inbox = await provider.listInbox(mailbox, { folder: 'inbox', limit: 10 });
    expect(inbox.status).toBe('ok');
    expect(inbox.threads).toHaveLength(3);
    expect(inbox.threads.map((thread) => thread.message_count)).toEqual([1, 1, 1]);

    expect(await controller.disconnect('workspace-one', user, mailbox.id)).toEqual({
      mailbox_id: mailbox.id,
      status: 'disconnected',
      credential: 'wiped',
    });
    expect(stored).toBeNull();
    expect(mailbox.active).toBe(false);
    expect((await provider.listInbox(mailbox, { folder: 'inbox', limit: 10 })).threads).toEqual([]);
    expect(server.commands).toEqual(expect.arrayContaining(['LOGIN [redacted]', 'UID SEARCH ALL']));
    expect(server.commands.some((command) => command.startsWith('SELECT INBOX'))).toBe(true);
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(server.sockets.every((socket) => socket.destroyed)).toBe(true);
    for (const secret of [wrongPassword, fixturePassword]) {
      expect(JSON.stringify(rejected)).not.toContain(secret);
      expect(JSON.stringify(logs)).not.toContain(secret);
      expect(JSON.stringify(server.commands)).not.toContain(secret);
    }
  });
});
