import { AgentInboxController } from '../agent-inbox/agent-inbox.controller';
import { MailboxAccount, User } from '@prisma/client';
import { ImapFlow, ImapFlowOptions } from 'imapflow';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { credentials, FakeImapServer } from '../../test/fake-imap.spec';
import { FakeSmtpServer } from '../../test/fake-smtp.spec';
import { ImapConnection } from './imap-connection';
import { Logger } from '@nestjs/common';
import { EmailService } from '../email/email.service';
import { MailController } from '../mail/mail.controller';
import { ExternalImapProvider } from './external-imap.provider';

const mailbox = {
  id: 'mailbox-one',
  workspaceId: 'workspace-one',
  provider: 'external_imap',
  ownerKind: 'HUMAN',
  ownerKey: 'owner-one',
  emailAddress: 'reader@example.com',
  active: true,
};
const input = {
  contactId: null,
  toAddress: 'recipient@example.com',
  subject: 'Plans',
  body: 'Reply',
  mode: 'send' as const,
  externalSource: 'email-ops-client',
  externalRef: 'ref-one',
  fromMailboxAccountId: mailbox.id,
};

describe('external IMAP existing send routing authorization', () => {
  const previousWorkspaceIds = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
  const previousImap = process.env.EXTERNAL_IMAP_ENABLED;
  const previousSend = process.env.EXTERNAL_IMAP_SEND_ENABLED;
  beforeEach(() => {
    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    const networkForbidden = () => {
      throw new Error('Network forbidden');
    };
    jest.spyOn(net, 'connect').mockImplementation(networkForbidden);
    jest.spyOn(tls, 'connect').mockImplementation(networkForbidden);
    jest.spyOn(dns, 'lookup').mockImplementation(networkForbidden);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
    expect(dns.lookup).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    if (previousWorkspaceIds === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = previousWorkspaceIds;
    if (previousImap === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = previousImap;
    if (previousSend === undefined) delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    else process.env.EXTERNAL_IMAP_SEND_ENABLED = previousSend;
  });

  it.each([
    ['session', {}, true],
    ['PAT', { __patAuth: {} }, false],
    ['federation', { __isFederationActor: true }, false],
    ['federated auth', { __isFederationAuth: true }, false],
  ] as const)(
    'the human compose front door checks %s identity before marking authorization',
    async (_kind, identity, authorized) => {
      const composeEmail = jest.fn();
      const controller = new MailController({ composeEmail } as unknown as EmailService);
      await controller.compose(
        'workspace-one',
        { id: 'owner-one', ...identity } as User,
        mailbox.id,
        {
          to_address: 'recipient@example.com',
          subject: 'Plans',
          body: 'Reply',
          // A hostile DTO field cannot supply the internal marker.
          sendAuthorization: 'human',
        } as any,
      );
      expect(composeEmail.mock.calls[0][3]).toBe(authorized);
      expect(composeEmail.mock.calls[0][2].sendAuthorization).toBeUndefined();
    },
  );

  it.each([{ __patAuth: {} }, { __isFederationActor: true }, { __isFederationAuth: true }])(
    'REST single and bulk approvals propagate non-human identity to the send guard',
    async (identity) => {
      const approveAgentInboxItem = jest.fn().mockResolvedValue({});
      const bulkApproveAgentInboxItems = jest.fn().mockResolvedValue({});
      const email = {
        approveAgentInboxItem,
        bulkApproveAgentInboxItems,
        peekAgentInboxKind: jest.fn().mockResolvedValue('EMAIL'),
      };
      const controller = new AgentInboxController(
        email as any,
        { assertCanReviewInbox: jest.fn() } as any,
      );
      const user = {
        id: 'owner-one',
        __ucUid: 'owner-one',
        __entitlements: ['email-ops', 'customer-ops'],
        ...identity,
      } as unknown as User;
      await controller.approve('workspace-one', user, 'item-one', {});
      expect(approveAgentInboxItem.mock.calls[0][5]).toBe(true);
      await controller.bulkApprove('workspace-one', user, { item_ids: ['item-one'] });
      expect(bulkApproveAgentInboxItems.mock.calls[0][5]).toBe(true);
      delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
      await controller.approve('workspace-one', user, 'item-one', {});
      expect(approveAgentInboxItem.mock.calls[1]).toHaveLength(5);
    },
  );

  function harness() {
    const now = new Date('2026-11-01T00:00:00Z');
    let message: any;
    let item: any;
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      mailboxAccount: {
        findMany: jest.fn().mockResolvedValue([mailbox]),
        findFirst: jest.fn().mockResolvedValue(mailbox),
      },
      agent: { findFirst: jest.fn().mockResolvedValue(null) },
      workspace: { findUnique: jest.fn().mockResolvedValue({ agentsPaused: false }) },
      emailMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(
          async ({ data }) =>
            (message = { id: 'message-one', createdAt: now, updatedAt: now, ...data }),
        ),
        update: jest.fn(async ({ data }) => (message = { ...message, ...data })),
      },
      agentInboxItem: {
        create: jest.fn(
          async ({ data }) => (item = { id: 'item-one', kind: 'EMAIL', createdAt: now, ...data }),
        ),
        findFirst: jest.fn(async () => ({ ...item, message })),
        update: jest.fn(async ({ data }) => (item = { ...item, ...data })),
      },
    };
    const prisma = {
      withWorkspace: jest.fn(async (_workspace, _user, operation) => operation(tx)),
    };
    const send = jest.fn().mockResolvedValue({
      accepted: true,
      providerMessageId: '<sent@example.com>',
      threadId: null,
      reason: null,
    });
    const provider = {
      handles: () => true,
      send,
      createDraft: jest.fn().mockResolvedValue({ created: false, reason: 'unavailable' }),
    };
    const service = new EmailService(prisma as any, {} as any, {} as any, provider as any);
    // Keep real compose/approve decisions and routing; isolate unrelated persistence projections.
    for (const method of ['rememberContacts', 'recordAction', 'reconcileMirroredDraft'])
      jest.spyOn(service as any, method).mockResolvedValue(undefined);
    jest.spyOn(service as any, 'mayActThroughMailbox').mockResolvedValue(true);
    jest.spyOn(service as any, 'composeView').mockImplementation((value) => value);
    jest.spyOn(service as any, 'inboxView').mockImplementation((value) => value);
    return { service, send, tx, provider };
  }

  it('stages a send lacking human authorization, then sends only on existing human approval', async () => {
    const { service, send, tx } = harness();
    await service.composeEmail('workspace-one', 'owner-one', input);
    expect(tx.agentInboxItem.create).toHaveBeenCalled();
    expect(tx.emailMessage.create.mock.calls[0][0].data.status).toBe('PENDING_APPROVAL');
    expect(send).not.toHaveBeenCalled();
    await service.approveAgentInboxItem('workspace-one', 'owner-one', 'item-one');
    expect(send).toHaveBeenCalledWith(
      mailbox,
      expect.objectContaining({ sendAuthorization: 'approval', body: 'Reply' }),
    );
  });

  it.each(['', 'workspace-two', 'WORKSPACE-ONE'])(
    'refuses human approval after the workspace is removed from the allowlist (%s)',
    async (allowlist) => {
      const { service, send, tx } = harness();
      const imap = new FakeImapServer();
      const smtp = new FakeSmtpServer();
      class TestConnection extends ImapConnection {
        protected createClient(options: ImapFlowOptions) {
          return new ImapFlow({ ...options, transport: imap });
        }
      }
      const accounts = {
        credentials: jest.fn().mockResolvedValue({
          ...credentials,
          smtp: { ...credentials, host: 'smtp.example.com', port: 587 },
        }),
      };
      const provider = new ExternalImapProvider(accounts as any, new TestConnection(), smtp);
      send.mockImplementation((box, req) => provider.send(box as MailboxAccount, req));
      await service.composeEmail('workspace-one', 'owner-one', input);
      expect(send).not.toHaveBeenCalled();

      process.env.EXTERNAL_IMAP_WORKSPACE_IDS = allowlist;
      await expect(
        service.approveAgentInboxItem('workspace-one', 'owner-one', 'item-one'),
      ).rejects.toThrow('Sending from this mailbox is not available yet.');
      expect(send).toHaveBeenCalledWith(
        mailbox,
        expect.objectContaining({ sendAuthorization: 'approval' }),
      );
      expect(accounts.credentials).not.toHaveBeenCalled();
      expect(smtp.messages).toHaveLength(0);
      expect(smtp.sockets).toHaveLength(0);
      expect(imap.connections).toHaveLength(0);
      expect(tx.agentInboxItem.update).not.toHaveBeenCalled();
      expect(tx.emailMessage.update).toHaveBeenCalledWith({
        where: { id: 'message-one' },
        data: expect.objectContaining({ status: 'FAILED', sentAt: null }),
      });

      // Re-enabling alone does nothing; the same pending draft needs a new human approval.
      process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
      expect(smtp.messages).toHaveLength(0);
      await service.approveAgentInboxItem('workspace-one', 'owner-one', 'item-one');
      expect(smtp.messages).toHaveLength(1);
      expect(imap.appended).toHaveLength(1);
      expect(smtp.sockets.every((socket) => socket.destroyed)).toBe(true);
      expect(imap.sockets.every((socket) => socket.destroyed)).toBe(true);
    },
  );

  it('rechecks an already approved scheduled draft when its send becomes due', async () => {
    const { service, send, tx } = harness();
    const smtp = new FakeSmtpServer();
    const accounts = { credentials: jest.fn() };
    const provider = new ExternalImapProvider(accounts as any, {} as ImapConnection, smtp);
    send.mockImplementation((box, req) => provider.send(box as MailboxAccount, req));
    await service.composeEmail('workspace-one', 'owner-one', input);
    const draft = await tx.agentInboxItem.findFirst();
    tx.agentInboxItem.findFirst.mockResolvedValue({
      ...draft,
      state: 'APPROVED',
      reviewedByUcUid: 'owner-one',
      payload: { sends_at: '2026-01-01T00:00:00Z' },
      message: { ...draft.message, sendAt: new Date('2026-01-01T00:00:00Z') },
    });
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-two';
    await expect(
      service.approveAgentInboxItem('workspace-one', 'owner-one', 'item-one'),
    ).rejects.toThrow('Sending from this mailbox is not available yet.');
    expect(send).toHaveBeenCalledWith(
      mailbox,
      expect.objectContaining({ sendAuthorization: 'approval' }),
    );
    expect(accounts.credentials).not.toHaveBeenCalled();
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.sockets).toHaveLength(0);
    expect(tx.agentInboxItem.update).not.toHaveBeenCalled();
    expect(tx.emailMessage.update).toHaveBeenCalledWith({
      where: { id: 'message-one' },
      data: expect.objectContaining({ status: 'FAILED', sentAt: null }),
    });
  });

  it('the existing human send path supplies the marker after normal mailbox authorization', async () => {
    const { service, send, tx } = harness();
    await service.composeEmail('workspace-one', 'owner-one', input, true);
    expect(tx.agentInboxItem.create).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      mailbox,
      expect.objectContaining({ sendAuthorization: 'human' }),
    );
  });

  it('an agent approval cannot gain an SMTP authorization marker', async () => {
    const { service, send, tx } = harness();
    await service.composeEmail('workspace-one', 'owner-one', input);
    // Exercise the agent approval branch without unrelated trusted-correspondent fixtures.
    tx.agentInboxItem.findFirst.mockImplementation(async () => ({
      id: 'item-one',
      kind: 'EMAIL',
      state: 'PENDING',
      draftedBy: null,
      message: {
        id: 'message-one',
        mailboxAccountId: mailbox.id,
        fromAddress: mailbox.emailAddress,
        toAddress: input.toAddress,
        subject: input.subject,
        body: input.body,
      },
    }));
    const refused = new ExternalImapProvider({} as any, {} as any);
    send.mockImplementation((box, req) => refused.send(box, req));
    await expect(
      service.approveAgentInboxItem('workspace-one', 'owner-one', 'item-one', null, false, true),
    ).rejects.toThrow('human send or approval');
    expect(send.mock.calls[0][1].sendAuthorization).toBeUndefined();
    expect(tx.agentInboxItem.update).not.toHaveBeenCalled();
  });
});
