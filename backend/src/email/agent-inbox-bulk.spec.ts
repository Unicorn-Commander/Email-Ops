import { AgentInboxApprovalTier, AgentInboxKind, AgentInboxState } from '@prisma/client';
import { EmailService } from './email.service';

function pendingItem(id: string) {
  return {
    id,
    workspaceId: 'workspace-test',
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
    createdAt: new Date('2026-11-03T23:30:00.000Z'),
    message: {
      id: `message-${id}`,
      mailboxAccountId: null,
      kitId: null,
      sendAt: null,
      fromAddress: 'sender@example.test',
      toAddress: `${id}@recipient.example.test`,
      toAddresses: [`${id}@recipient.example.test`],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Fictional subject',
      body: 'Fictional body',
      bodyHtml: null,
      attachments: null,
    },
  };
}

describe('EmailService bulk agent-inbox approval', () => {
  it('reserves a direct-draft schedule and is idempotent after the approval update', async () => {
    const rows = [pendingItem('item-a'), pendingItem('item-b')];
    const tx: any = {
      user: undefined,
      membership: undefined,
      mailboxAccount: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      agentSendKit: { findMany: jest.fn().mockResolvedValue([]) },
      emailMessage: {
        count: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const row = rows.find((item) => item.message.id === where.id);
          if (row) row.message.sendAt = data.sendAt;
          return Promise.resolve(row?.message);
        }),
      },
      agentInboxItem: {
        findMany: jest.fn().mockImplementation(() => Promise.resolve(rows)),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const row = rows.find((item) => item.id === where.id);
          if (!row) return Promise.resolve(null);
          Object.assign(row, data);
          return Promise.resolve(row);
        }),
      },
      agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      withWorkspace: jest.fn(
        (_workspace: string, _uid: string | null, fn: (value: unknown) => unknown) => fn(tx),
      ),
    } as any;
    const service = new EmailService(prisma, {} as never, {} as never, {} as never);

    const first = await service.bulkApproveAgentInboxItems(
      'workspace-test',
      'human-reviewer',
      ['item-a', 'item-b'],
      'fictional note',
      false,
      false,
    );

    expect(first.approved_count).toBe(2);
    expect(first.schedule.count).toBe(2);
    expect(
      new Date(first.items[1].send_at!).getTime() - new Date(first.items[0].send_at!).getTime(),
    ).toBe(2000);
    expect(tx.agentActionEvent.create).toHaveBeenCalledTimes(2);

    const second = await service.bulkApproveAgentInboxItems(
      'workspace-test',
      'human-reviewer',
      ['item-a', 'item-b'],
      'fictional note',
      false,
      false,
    );

    expect(second.items.map((item) => item.status)).toEqual([
      'already_approved',
      'already_approved',
    ]);
    expect(tx.agentActionEvent.create).toHaveBeenCalledTimes(2);
    expect(tx.emailMessage.update).toHaveBeenCalledTimes(2);
  });
});
