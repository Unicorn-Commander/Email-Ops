import { User } from '@prisma/client';
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
  const previousImap = process.env.EXTERNAL_IMAP_ENABLED;
  const previousSend = process.env.EXTERNAL_IMAP_SEND_ENABLED;
  beforeEach(() => {
    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    process.env.EXTERNAL_IMAP_SEND_ENABLED = 'true';
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previousImap === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = previousImap;
    if (previousSend === undefined) delete process.env.EXTERNAL_IMAP_SEND_ENABLED;
    else process.env.EXTERNAL_IMAP_SEND_ENABLED = previousSend;
  });

  it.each([false, true])(
    'the human compose front door marks session authorization, PAT=%s',
    async (pat) => {
      const composeEmail = jest.fn();
      const controller = new MailController({ composeEmail } as unknown as EmailService);
      await controller.compose(
        'workspace-one',
        { id: 'owner-one', ...(pat ? { __patAuth: {} } : {}) } as User,
        mailbox.id,
        {
          to_address: 'recipient@example.com',
          subject: 'Plans',
          body: 'Reply',
          // A hostile DTO field cannot supply the internal marker.
          sendAuthorization: 'human',
        } as any,
      );
      expect(composeEmail.mock.calls[0][3]).toBe(!pat);
      expect(composeEmail.mock.calls[0][2].sendAuthorization).toBeUndefined();
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
    const send = jest
      .fn()
      .mockResolvedValue({
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
