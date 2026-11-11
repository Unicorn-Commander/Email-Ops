// SMTP send gate (#83 phase 2): EXTERNAL_IMAP_SEND_ENABLED is off by default.
// A closed gate must refuse before credentials or the SMTP transport are used,
// and the SMTP password must never reach error text or logs.
import { Logger, NotFoundException } from '@nestjs/common';
import { MailboxAccount } from '@prisma/client';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { MailProviderSendRequest } from '../mail-provider/mail-provider.port';
import { credentials, fixturePassword, fixtureUsername } from '../../test/fake-imap.spec';
import { ImapConnection } from './imap-connection';
import { ExternalImapAccounts } from './external-imap.accounts';
import { ExternalImapProvider, IMAP_SEND_UNAVAILABLE } from './external-imap.provider';
import { SmtpConnection, SmtpCredentials } from './smtp-connection';

const smtpCredentials: SmtpCredentials = {
  host: 'smtp.example.com',
  port: 587,
  username: fixtureUsername,
  password: fixturePassword,
};
const mailbox = {
  id: 'mailbox-one',
  workspaceId: 'workspace-one',
  provider: 'external_imap',
  emailAddress: 'reader@example.com',
} as MailboxAccount;
const request = (sendAuthorization: 'human' | 'approval'): MailProviderSendRequest => ({
  sendAuthorization,
  from: 'reader@example.com',
  to: 'recipient@example.com',
  subject: 'Plans',
  body: 'Reply',
});

// Flatten anything (Buffers, Errors, objects) so a password cannot hide inside.
function text(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('latin1');
  if (value instanceof Error) return `${value.name} ${value.message} ${value.stack ?? ''}`;
  if (value && typeof value === 'object')
    return Object.entries(value)
      .map(([key, item]) => `${key} ${text(item)}`)
      .join(' ');
  return String(value);
}

describe('external mailbox SMTP send gate', () => {
  const previousEnabled = process.env.EXTERNAL_IMAP_ENABLED;
  const previousAllowlist = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
  const previousSend = process.env.EXTERNAL_IMAP_SEND_ENABLED;
  let logs: jest.SpyInstance[] = [];

  beforeEach(() => {
    // Connected IMAP account in an IMAP-enabled workspace; only the send flag varies.
    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
    delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    const networkForbidden = () => {
      throw new Error('Network forbidden');
    };
    jest.spyOn(net, 'connect').mockImplementation(networkForbidden);
    jest.spyOn(tls, 'connect').mockImplementation(networkForbidden);
    jest.spyOn(dns, 'lookup').mockImplementation(networkForbidden);
    logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => {}),
    );
  });
  afterEach(() => {
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
    for (const spy of logs)
      for (const call of spy.mock.calls) expect(text(call)).not.toContain(fixturePassword);
    jest.restoreAllMocks();
    if (previousEnabled === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = previousEnabled;
    if (previousAllowlist === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = previousAllowlist;
    if (previousSend === undefined) delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    else process.env.EXTERNAL_IMAP_SEND_ENABLED = previousSend;
  });

  function harness() {
    const transport = { run: jest.fn().mockResolvedValue(undefined) };
    const client = {
      list: jest
        .fn()
        .mockResolvedValue([{ path: 'Sent', specialUse: '\\Sent', flags: new Set(['\\Sent']) }]),
      append: jest.fn().mockResolvedValue(true),
    };
    const connection = {
      run: jest.fn(async (_workspaceId: string, _creds: unknown, operation: any) =>
        operation(client),
      ),
    } as unknown as ImapConnection;
    const accounts = {
      credentials: jest.fn().mockResolvedValue({ ...credentials, smtp: { ...smtpCredentials } }),
    } as unknown as ExternalImapAccounts;
    const provider = new ExternalImapProvider(
      accounts,
      connection,
      transport as unknown as SmtpConnection,
    );
    return { provider, transport, accounts, client };
  }

  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['FALSE', 'FALSE'],
    ['True', 'True'],
    ['TRUE', 'TRUE'],
    ['1', '1'],
    ['0', '0'],
    ['empty', ''],
  ] as const)(
    'refuses a send with EXTERNAL_IMAP_SEND_ENABLED %s and hands nothing to the transport',
    async (_label, value) => {
      if (value === undefined) delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
      else process.env.EXTERNAL_IMAP_SEND_ENABLED = value;
      const { provider, transport, accounts, client } = harness();
      const result = await provider.send(mailbox, request('approval'));
      expect(result).toEqual({
        accepted: false,
        providerMessageId: null,
        threadId: null,
        reason: IMAP_SEND_UNAVAILABLE,
      });
      expect(result.reason).toBe('Sending from this mailbox is not available yet.');
      expect(transport.run).not.toHaveBeenCalled();
      expect(accounts.credentials).not.toHaveBeenCalled();
      expect(client.append).not.toHaveBeenCalled();
      expect(text(result)).not.toContain(fixturePassword);
    },
  );

  it.each(['human', 'approval'] as const)(
    'refuses %s authorization the same way when the workspace is not in the allow list',
    async (sendAuthorization) => {
      process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
      process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-two';
      const { provider, transport, accounts, client } = harness();
      const result = await provider.send(mailbox, request(sendAuthorization));
      expect(result).toEqual({
        accepted: false,
        providerMessageId: null,
        threadId: null,
        reason: IMAP_SEND_UNAVAILABLE,
      });
      expect(transport.run).not.toHaveBeenCalled();
      expect(accounts.credentials).not.toHaveBeenCalled();
      expect(client.append).not.toHaveBeenCalled();
      expect(text(result)).not.toContain(fixturePassword);
    },
  );

  it('calls the SMTP transport exactly once when the flag is on and the workspace is listed', async () => {
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    const { provider, transport, client } = harness();
    const result = await provider.send(mailbox, request('approval'));
    expect(result).toMatchObject({ accepted: true, threadId: null, reason: null });
    expect(transport.run).toHaveBeenCalledTimes(1);
    const [workspaceId, creds, message] = transport.run.mock.calls[0];
    expect(workspaceId).toBe('workspace-one');
    expect(creds).toMatchObject({ host: 'smtp.example.com', port: 587 });
    expect(message.from).toBe('reader@example.com');
    expect(message.recipients).toEqual(['recipient@example.com']);
    expect(Buffer.isBuffer(message.raw)).toBe(true);
    const raw = message.raw.toString();
    expect(raw).toContain('From: reader@example.com\r\n');
    // Subjects travel as RFC 2047 encoded words.
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('Plans').toString('base64')}?=`);
    expect(client.append).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['flag off', () => delete process.env.EXTERNAL_IMAP_SEND_ENABLED],
    [
      'flag on, workspace unlisted',
      () => {
        process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
        process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-two';
      },
    ],
  ] as const)(
    'the SMTP transport itself refuses with NotFoundException when the gate is closed (%s)',
    async (_label, closeGate) => {
      closeGate();
      const smtp = new SmtpConnection();
      const message = {
        from: 'reader@example.com',
        recipients: ['recipient@example.com'],
        raw: Buffer.from('Subject: Plans\r\n\r\nReply\r\n'),
      };
      await expect(smtp.run('workspace-one', smtpCredentials, message)).rejects.toThrow(
        NotFoundException,
      );
      await expect(smtp.test('workspace-one', smtpCredentials)).rejects.toThrow(NotFoundException);
      const error = await smtp.run('workspace-one', smtpCredentials, message).catch((e) => e);
      expect(text(error)).not.toContain(fixturePassword);
    },
  );

  it('keeps the SMTP password out of the refusal when the transport itself fails', async () => {
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    const { provider, transport, client } = harness();
    transport.run.mockRejectedValueOnce(
      new Error(`SMTP AUTH rejected for ${fixtureUsername}: ${fixturePassword}`),
    );
    const result = await provider.send(mailbox, request('approval'));
    expect(result).toMatchObject({
      accepted: false,
      providerMessageId: null,
      reason: 'The SMTP message could not be sent.',
    });
    expect(text(result)).not.toContain(fixturePassword);
    // A failed SMTP delivery must not leave a Sent copy behind.
    expect(client.append).not.toHaveBeenCalled();
  });
});
