import { ForbiddenException } from '@nestjs/common';
import { AgentInboxApprovalTier, AgentInboxKind, AgentInboxState } from '@prisma/client';
import {
  RECIPIENT_SUPPRESSED,
  RECIPIENT_SUPPRESSED_MESSAGE,
} from '../unsubscribe/suppression.service';
import { EmailService } from './email.service';

function pendingItem(id = 'item-fictional-555') {
  return {
    id,
    workspaceId: 'workspace-fictional-555',
    messageId: `message-${id}`,
    kind: AgentInboxKind.EMAIL,
    approvalTier: AgentInboxApprovalTier.MAILBOX_OWNER,
    approvalReason: null,
    payload: null,
    state: AgentInboxState.PENDING,
    draftedBy: 'fictional-agent',
    summary: 'Fictional queue item',
    reviewedByUcUid: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date('2026-11-05T03:00:00.000Z'),
    message: {
      id: `message-${id}`,
      mailboxAccountId: null,
      kitId: null,
      sendAt: null,
      fromAddress: 'sender@example.test',
      toAddress: 'reader@example.test',
      toAddresses: ['reader@example.test'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Fictional subject',
      body: 'Fictional body',
      bodyHtml: null,
      attachments: null,
    },
  };
}

function serviceWithSuppression(
  suppression: Record<string, jest.Mock>,
  tx: Record<string, unknown> = {},
): EmailService {
  const prisma = {
    withWorkspace: jest.fn(
      async (_workspace: string, _uid: string | null, fn: (value: unknown) => unknown) => fn(tx),
    ),
  } as any;
  return new EmailService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    suppression as any,
  );
}

describe('EmailService suppression gate', () => {
  it.each(['send', 'draft'] as const)(
    'refuses compose mode=%s before recording a row',
    async (mode) => {
      const gate = jest.fn().mockRejectedValue(new ForbiddenException(RECIPIENT_SUPPRESSED));
      const service = serviceWithSuppression({ assertRecipientsNotSuppressed: gate });

      await expect(
        service.composeEmail('workspace-fictional-555', 'fictional-reviewer-555', {
          contactId: null,
          toAddress: 'Reader <READER@example.test>',
          subject: 'Fictional subject',
          body: 'Fictional body',
          mode,
          externalSource: 'email-ops-client',
          externalRef: `suppression-${mode}-fictional-555`,
        }),
      ).rejects.toThrow(RECIPIENT_SUPPRESSED);
      expect(gate).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses a single approval and records the stable reason on the inbox row', async () => {
    const item = pendingItem();
    const gate = jest.fn().mockResolvedValue({ email: 'reader@example.test' });
    const tx: any = {
      agentInboxItem: {
        findFirst: jest.fn().mockResolvedValue(item),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ ...item, ...data })),
      },
      mailboxAccount: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = serviceWithSuppression({ findSuppressedInTx: gate }, tx);

    await expect(
      service.approveAgentInboxItem('workspace-fictional-555', 'fictional-reviewer-555', item.id),
    ).rejects.toMatchObject({
      response: {
        reason: RECIPIENT_SUPPRESSED,
        message: RECIPIENT_SUPPRESSED_MESSAGE,
      },
    });
    expect(tx.agentInboxItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ approvalReason: RECIPIENT_SUPPRESSED }),
      }),
    );
  });

  it('refuses each suppressed row in bulk approval without scheduling it', async () => {
    const item = pendingItem('item-bulk-fictional-555');
    const gate = jest.fn().mockResolvedValue({ email: 'reader@example.test' });
    const tx: any = {
      mailboxAccount: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      agentSendKit: { findMany: jest.fn().mockResolvedValue([]) },
      emailMessage: { count: jest.fn(), update: jest.fn() },
      agentInboxItem: {
        findMany: jest.fn().mockResolvedValue([item]),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve(Object.assign(item, data))),
      },
      agentActionEvent: { create: jest.fn() },
    };
    const service = serviceWithSuppression({ findSuppressedInTx: gate }, tx);

    const result = await service.bulkApproveAgentInboxItems(
      'workspace-fictional-555',
      'fictional-reviewer-555',
      [item.id],
      'fictional review',
      false,
      false,
    );

    expect(result.items).toEqual([
      { item_id: item.id, status: 'refused', reason: RECIPIENT_SUPPRESSED },
    ]);
    expect(result.refused_count).toBe(1);
    expect(item.approvalReason).toBe(RECIPIENT_SUPPRESSED);
    expect(tx.emailMessage.update).not.toHaveBeenCalled();
  });
});
