import { ImapFlow, ImapFlowOptions } from 'imapflow';
import { Logger, NotFoundException } from '@nestjs/common';
import { MailboxAccount, MailboxOwnerKind, MailboxProvisionState, User } from '@prisma/client';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import {
  credentials,
  FakeImapServer,
  fixturePassword,
  fixtureUsername,
} from '../../test/fake-imap.spec';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { EmailOpsTools } from '../mcp/mcp.tools';
import { PrismaService } from '../prisma/prisma.service';
import { ExternalImapAccounts } from './external-imap.accounts';
import { ExternalImapController } from './external-imap.controller';
import { ExternalImapProvider } from './external-imap.provider';
import { ImapConnection } from './imap-connection';
import { MailboxAccountsController } from '../mailbox-accounts/mailbox-accounts.controller';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';

class TestConnection extends ImapConnection {
  constructor(readonly server: FakeImapServer) {
    super();
  }
  protected createClient(options: ImapFlowOptions) {
    return new ImapFlow({ ...options, transport: this.server });
  }
}

const MUTATING = /\b(APPEND|STORE|EXPUNGE|MOVE|DELETE)\b/i;

describe('external IMAP regression (#81)', () => {
  const previousWorkspaceIds = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
  const previousSendFlag = process.env.EXTERNAL_IMAP_SEND_ENABLED;
  const previousFlag = process.env.EXTERNAL_IMAP_ENABLED;
  const previousKey = process.env.CONNECTED_ACCOUNT_ENC_KEY;
  const user = { id: 'user-one', keycloakId: 'subject-one', __ucUid: 'subject-one' } as User & {
    __ucUid: string;
  };
  let server: FakeImapServer;
  let connection: TestConnection;
  let accounts: ExternalImapAccounts;
  let provider: ExternalImapProvider;
  let controller: ExternalImapController;
  let mailbox: MailboxAccount;
  let row: Record<string, unknown> | null;
  let tx: any;
  let prisma: any;
  let logs: string[];

  function assertNoSecrets(value: unknown, ciphertext?: string) {
    const serialized = JSON.stringify(value);
    expect(serialized.includes(fixturePassword)).toBe(false);
    expect(serialized.includes('"password"')).toBe(false);
    expect(serialized.includes('encryptedPassword')).toBe(false);
    expect(serialized.includes('secretRef')).toBe(false);
    expect(serialized.includes('vault-should-not-leak')).toBe(false);
    expect(serialized.includes('imap.example.com')).toBe(false);
    if (ciphertext) expect(serialized.includes(ciphertext)).toBe(false);
  }

  beforeEach(() => {
    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
    delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    process.env.CONNECTED_ACCOUNT_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
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
        create: jest.fn().mockImplementation(async ({ data }) => ({ ...mailbox, ...data })),
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
    const serialized = JSON.stringify(logs);
    expect(serialized.includes(fixturePassword)).toBe(false);
    expect(serialized.includes(fixtureUsername)).toBe(false);
    expect(server.commands.join('\n').includes(fixturePassword)).toBe(false);
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    if (previousWorkspaceIds === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = previousWorkspaceIds;
    if (previousSendFlag === undefined) delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    else process.env.EXTERNAL_IMAP_SEND_ENABLED = previousSendFlag;
    if (previousFlag === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = previousFlag;
    if (previousKey === undefined) delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    else process.env.CONNECTED_ACCOUNT_ENC_KEY = previousKey;
  });

  async function register() {
    const result = await controller.connect('workspace-one', user, {
      ...credentials,
      email_address: 'reader@example.com',
    });
    expect(result).toEqual({ status: 'ok', mailbox_id: 'mailbox-one' });
    return result;
  }

  it('flag off: the connect route is 404 and nothing is stored', async () => {
    delete process.env.EXTERNAL_IMAP_ENABLED;
    expect(controller.capabilities('workspace-one')).toEqual({ enabled: false });
    expect(() =>
      controller.test('workspace-one', user, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).toThrow(NotFoundException);
    expect(() =>
      controller.connect('workspace-one', user, {
        ...credentials,
        email_address: 'reader@example.com',
      }),
    ).toThrow(NotFoundException);
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(tx.mailboxAccount.create).not.toHaveBeenCalled();
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
    expect(server.connections).toHaveLength(0);
    expect(row).toBeNull();
  });

  it('stores the password encrypted and no read endpoint or tool returns it', async () => {
    const connected = await register();
    const ciphertext = String(row?.encryptedPassword);
    expect(ciphertext.includes(fixturePassword)).toBe(false);
    expect(ciphertext.length).toBeGreaterThan(fixturePassword.length);

    const probed = await controller.test('workspace-one', user, {
      ...credentials,
      email_address: 'reader@example.com',
    });
    const listed = await provider.listInbox(mailbox, { folder: 'inbox', limit: 10 });
    const threadId = listed.threads[0]?.id ?? '';
    const detail = await provider.listThreadMessages(mailbox, threadId);
    const attachment = await provider.downloadAttachment(mailbox, 'imap-42-1', '2');

    const stored = mailboxRecord(ciphertext);
    const reads = await readSurfaces(stored, ciphertext);
    for (const value of [
      connected,
      probed,
      listed,
      detail,
      attachment && { ...attachment, data: null },
      reads,
    ]) {
      assertNoSecrets(value, ciphertext);
    }
    expect(reads.list.items[0]).not.toHaveProperty('password');
    expect(reads.list.items[0]).not.toHaveProperty('encryptedPassword');
    expect(reads.tool.accounts[0]).toEqual({
      id: 'mailbox-one',
      address: 'reader@example.com',
      display_name: null,
      provider: 'external_imap',
      role: 'human',
      is_default: false,
    });
    expect(reads.queries.some((query) => JSON.stringify(query).includes('externalImap'))).toBe(
      false,
    );
  });

  it('browse, download, and refused writes issue no APPEND, STORE, EXPUNGE, MOVE, or DELETE', async () => {
    await register();
    const listed = await provider.listInbox(mailbox, { folder: 'inbox', limit: 50 });
    expect(listed.status).toBe('ok');
    const threadId = listed.threads[0].id;
    const detail = await provider.listThreadMessages(mailbox, threadId);
    expect(detail.status).toBe('ok');
    expect(await provider.downloadAttachment(mailbox, detail.messages[0].id, '2')).not.toBeNull();
    const port: MailProviderPort = provider;
    expect(await port.send(mailbox, { from: '', to: '', subject: '', body: '' })).toMatchObject({
      accepted: false,
    });
    expect(await port.archiveThread(mailbox, threadId)).toBe(false);
    expect(await port.trashThread(mailbox, threadId)).toBe(false);
    expect(await port.deleteDraft(mailbox, 'draft')).toBe(false);
    expect(await port.spamThread(mailbox, threadId)).toBe(false);
    expect(await port.restoreThreadToInbox(mailbox, threadId)).toBe(false);
    expect(server.commands.filter((command) => MUTATING.test(command))).toEqual([]);
    expect(server.seen.size).toBe(0);
  });

  it('wrong password is auth_failed and the password is not echoed', async () => {
    const result = await controller.connect('workspace-one', user, {
      ...credentials,
      password: 'incorrect-app-password',
      email_address: 'reader@example.com',
    });
    expect(result).toEqual({ status: 'auth_failed' });
    assertNoSecrets(result);
    expect(JSON.stringify(result).includes('incorrect-app-password')).toBe(false);
    expect(JSON.stringify(result).includes('AUTHENTICATIONFAILED')).toBe(false);
    expect(tx.externalImapAccount.upsert).not.toHaveBeenCalled();
    expect(tx.mailboxAccount.create).not.toHaveBeenCalled();
    expect(row).toBeNull();
  });

  it('another workspace cannot read or use the connector', async () => {
    // Exercise credential isolation even when both workspaces are enabled.
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one,workspace-two';
    await register();
    const sessions = server.connections.length;
    const ciphertext = String(row?.encryptedPassword);
    tx.externalImapAccount.findFirst.mockImplementation(async ({ where }) => {
      if (where?.mailbox?.workspaceId !== 'workspace-one') return null;
      if (where?.mailboxId !== mailbox.id) return null;
      return row;
    });
    const foreign = {
      ...mailbox,
      id: 'mailbox-foreign',
      workspaceId: 'workspace-two',
      emailAddress: 'other@example.com',
    } as MailboxAccount;
    const listed = await provider.listInbox(foreign, { folder: 'inbox', limit: 10 });
    expect(listed).toMatchObject({ status: 'engine_unreachable', threads: [] });
    assertNoSecrets(listed, ciphertext);
    await expect(accounts.credentials(foreign)).rejects.toThrow('Mailbox unavailable');
    expect(server.connections).toHaveLength(sessions);
    expect(row?.encryptedPassword).toBe(ciphertext);
    expect(prisma.withWorkspace).toHaveBeenCalledWith(
      'workspace-two',
      'subject-one',
      expect.any(Function),
    );
    expect(tx.externalImapAccount.upsert).toHaveBeenCalledTimes(1);
  });
});

function mailboxRecord(ciphertext: string): MailboxAccount & { externalImap: unknown } {
  return {
    id: 'mailbox-one',
    workspaceId: 'workspace-one',
    emailAddress: 'reader@example.com',
    displayName: null,
    ownerKind: MailboxOwnerKind.HUMAN,
    ownerKey: 'subject-one',
    provider: 'external_imap',
    kind: 'external_imap',
    provisionState: MailboxProvisionState.REGISTERED,
    isDefault: false,
    postmarkLane: false,
    active: true,
    secretRef: 'vault-should-not-leak',
    imapHost: 'imap.example.com',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    externalImap: {
      host: 'imap.example.com',
      username: fixtureUsername,
      encryptedPassword: ciphertext,
      password: fixturePassword,
    },
  } as MailboxAccount & { externalImap: unknown };
}

async function readSurfaces(stored: MailboxAccount, ciphertext: string) {
  const queries: unknown[] = [];
  const tx = {
    mailboxAccount: {
      findMany: jest.fn(async (args) => {
        queries.push(args);
        return [stored];
      }),
      findFirst: jest.fn(async (args) => {
        queries.push(args);
        return stored;
      }),
    },
    agentMailbox: {
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const prisma = {
    withWorkspace: jest.fn((_workspace: string, _user: string, fn: (db: typeof tx) => unknown) =>
      fn(tx),
    ),
  };
  const mailboxes = new MailboxAccountsService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
  );
  const http = new MailboxAccountsController(
    mailboxes,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const caller = { id: 'user-one', keycloakId: 'subject-one', __ucUid: 'subject-one' } as User & {
    __ucUid: string;
  };
  const list = await http.list('workspace-one', caller);
  const one = await http.get('workspace-one', caller, 'mailbox-one');
  const tools = new EmailOpsTools(
    { resolveAndAuthorize: jest.fn().mockResolvedValue('workspace-one') } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    mailboxes,
    {} as never,
    {} as never,
    {
      isConfigured: () => true,
      listAccounts: async () => [{ address: 'reader@example.com' }],
    } as never,
    {
      listDomains: async () => [{ domain: 'example.com' }],
      domainOf: (address: string) => address.split('@')[1]?.toLowerCase(),
    } as never,
  );
  const tool = await tools.listMailAccounts(caller, { workspace_id: 'workspace-one' });
  expect(JSON.stringify(one).includes(ciphertext)).toBe(false);
  return { list, one, tool: tool as { accounts: unknown[] }, queries };
}
