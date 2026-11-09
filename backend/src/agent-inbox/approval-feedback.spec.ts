import { createHash } from 'crypto';
import {
  AgentInboxApprovalTier,
  AgentInboxKind,
  AgentInboxState,
  EmailMessageStatus,
  EmailMode,
  WorkspaceRole,
} from '@prisma/client';
import { EmailService } from '../email/email.service';
import { AgentInboxController } from './agent-inbox.controller';
import { EmailOpsTools } from '../mcp/mcp.tools';
import { MCP_MANIFEST_CATALOG } from '../mcp/mcp-manifest.catalog';

const WS = 'fictional-workspace';
const UID = 'fictional-reviewer';
const DRAFT = 'Hello Zoë,\r\nYour appointment is Tuesday.\n';
const hash = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex');

function pendingItem(id = 'item-1') {
  return {
    id,
    workspaceId: WS,
    messageId: `message-${id}`,
    kind: AgentInboxKind.EMAIL,
    approvalTier: AgentInboxApprovalTier.MAILBOX_OWNER,
    approvalReason: null,
    state: AgentInboxState.PENDING as AgentInboxState,
    draftedBy: 'fictional-agent',
    summary: 'Appointment',
    payload: null as any,
    bodySha256: hash(DRAFT) as string | null,
    sentBodySha256: null as string | null,
    editedBeforeSend: null as boolean | null,
    factualCorrection: null as boolean | null,
    reviewedByUcUid: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: new Date('2026-11-01T12:00:00Z'),
    message: {
      id: `message-${id}`,
      mailboxAccountId: null,
      kitId: null,
      sendAt: null as Date | null,
      fromAddress: 'sender@example.com',
      toAddress: 'reader@example.com',
      toAddresses: ['reader@example.com'],
      ccAddresses: [],
      bccAddresses: [],
      subject: 'Appointment',
      body: DRAFT,
      bodyHtml: null,
      attachments: null,
      mode: EmailMode.DRAFT,
      status: EmailMessageStatus.PENDING_APPROVAL,
      createdAt: new Date('2026-11-01T12:00:00Z'),
    },
  };
}

function harness(rows = [pendingItem()]) {
  const tx = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ agentsPaused: false }) },
    agent: { findFirst: jest.fn().mockResolvedValue(null) },
    mailboxAccount: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    agentSendKit: { findMany: jest.fn().mockResolvedValue([]) },
    emailMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => ({ ...rows[0].message, ...data })),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const message = rows.find((row) => row.message.id === where.id)!.message;
        return Object.assign(message, data);
      }),
    },
    agentInboxItem: {
      create: jest.fn().mockImplementation(({ data }) => Object.assign(rows[0], data)),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }) => rows.find((row) => row.id === where.id)),
      findMany: jest.fn().mockImplementation(() => rows),
      update: jest
        .fn()
        .mockImplementation(({ where, data }) =>
          Object.assign(rows.find((row) => row.id === where.id)!, data),
        ),
    },
    agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    withWorkspace: jest.fn(async (_ws, _uid, fn) => fn(tx)),
  } as any;
  const service = new EmailService(prisma, {} as never, {} as never, {} as never);
  // No provider or network is used: the real approval service sees a simulated send result.
  const send = jest.spyOn(service as any, 'callEngine').mockResolvedValue({
    accepted: true,
    providerMessageId: 'fictional-provider-message',
  });
  return { rows, tx, service, send };
}

describe('agent-inbox approval evidence', () => {
  it('captures the immutable baseline when a draft is staged', async () => {
    const { service, tx, send } = harness();
    await service.composeEmail(WS, UID, {
      contactId: null,
      toAddress: 'reader@example.com',
      subject: 'Appointment',
      body: DRAFT,
      mode: 'draft',
      externalSource: 'email-ops-client',
      externalRef: 'fictional-compose',
    });
    expect(tx.agentInboxItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bodySha256: hash(DRAFT) }),
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['unchanged', DRAFT, false],
    ['edited', DRAFT.replace('Tuesday', 'Wednesday'), true],
    ['line endings changed', DRAFT.replace(/\r\n/g, '\n'), true],
    ['empty body', '', true],
  ])('approves %s text and audits both hashes', async (_label, body, edited) => {
    const { rows, service, tx, send } = harness();
    rows[0].message.body = body as string;
    const out = await service.approveAgentInboxItem(
      WS,
      UID,
      rows[0].id,
      'Checked date',
      false,
      false,
      WorkspaceRole.MEMBER,
      true,
    );
    const evidence = {
      body_sha256: hash(DRAFT),
      sent_body_sha256: hash(body as string),
      edited_before_send: edited,
      factual_correction: true,
      review_note: 'Checked date',
    };
    expect(out?.inbox).toMatchObject(evidence);
    expect(send).toHaveBeenCalledWith(null, expect.objectContaining({ body }));
    expect(JSON.parse(tx.agentActionEvent.create.mock.calls[0][0].data.detail)).toMatchObject(
      evidence,
    );
    expect(await service.listAgentInbox(WS, UID, AgentInboxState.APPROVED)).toEqual([
      expect.objectContaining(evidence),
    ]);
    expect(await service.getAgentInboxItemDetail(WS, UID, rows[0].id)).toMatchObject(evidence);
    // A retry must preserve the original decision and reviewer feedback.
    await service.approveAgentInboxItem(
      WS,
      UID,
      rows[0].id,
      'retry',
      false,
      false,
      WorkspaceRole.MEMBER,
      false,
    );
    expect(rows[0].factualCorrection).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(tx.agentActionEvent.create).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy comparisons and omitted factual feedback unknown', async () => {
    const { rows, service } = harness();
    rows[0].bodySha256 = null;
    const out = await service.approveAgentInboxItem(WS, UID, rows[0].id);
    expect(out?.inbox).toMatchObject({
      sent_body_sha256: hash(DRAFT),
      edited_before_send: null,
      factual_correction: null,
    });
    expect(rows[0].bodySha256).toBeNull();
  });

  it('does not record successful approval evidence when sending fails', async () => {
    const { rows, service, send, tx } = harness();
    send.mockResolvedValue({ accepted: false, reason: 'Fictional send failure' });
    await expect(service.approveAgentInboxItem(WS, UID, rows[0].id)).rejects.toThrow(
      'Fictional send failure',
    );
    expect(rows[0]).toMatchObject({
      state: AgentInboxState.PENDING,
      sentBodySha256: null,
      editedBeforeSend: null,
    });
    expect(tx.agentActionEvent.create).not.toHaveBeenCalled();
  });

  it('records bulk evidence independently and preserves feedback during scheduled delivery', async () => {
    const { rows, service, tx } = harness([
      pendingItem('unchanged'),
      pendingItem('edited'),
      pendingItem('legacy'),
    ]);
    rows[1].message.body = 'Corrected appointment';
    rows[2].bodySha256 = null;
    const out = await service.bulkApproveAgentInboxItems(
      WS,
      UID,
      rows.map((row) => row.id),
      'Reviewed batch',
      false,
      false,
      WorkspaceRole.MEMBER,
      false,
    );
    expect(out.approved_count).toBe(3);
    expect(rows.map((row) => row.editedBeforeSend)).toEqual([false, true, null]);
    for (const [index, row] of rows.entries()) {
      expect(row.sentBodySha256).toBe(hash(row.message.body));
      expect(row.factualCorrection).toBe(false);
      expect(JSON.parse(tx.agentActionEvent.create.mock.calls[index][0].data.detail)).toMatchObject(
        {
          body_sha256: row.bodySha256,
          sent_body_sha256: row.sentBodySha256,
          edited_before_send: row.editedBeforeSend,
          factual_correction: false,
          review_note: 'Reviewed batch',
        },
      );
    }
    await service.bulkApproveAgentInboxItems(
      WS,
      UID,
      rows.map((row) => row.id),
      'retry',
      false,
      false,
      WorkspaceRole.MEMBER,
      true,
    );
    expect(tx.agentActionEvent.create).toHaveBeenCalledTimes(3);
    rows[1].message.sendAt = new Date(Date.now() - 1000);
    await service.approveAgentInboxItem(WS, UID, rows[1].id);
    expect(rows[1]).toMatchObject({
      factualCorrection: false,
      editedBeforeSend: true,
      reviewNote: 'Reviewed batch',
    });
    expect(tx.agentActionEvent.create).toHaveBeenCalledTimes(3);
  });

  it('exposes null evidence for old rows without backfilling it during reads', async () => {
    const { rows, service, tx } = harness();
    rows[0].bodySha256 = null;
    rows[0].state = AgentInboxState.APPROVED;
    const [item] = await service.listAgentInbox(WS, UID, AgentInboxState.APPROVED);
    expect(item).toMatchObject({
      sent_body_sha256: null,
      edited_before_send: null,
      factual_correction: null,
    });
    expect(tx.agentInboxItem.update).not.toHaveBeenCalled();
  });
});

describe('approval feedback REST and MCP contracts', () => {
  const user = { __ucUid: UID, __entitlements: ['customer-ops', 'email-ops'] } as any;
  function fronts() {
    const { service, rows } = harness();
    const membership = {
      assertCanReviewInbox: jest.fn().mockResolvedValue(WS),
      resolveWithRole: jest.fn().mockResolvedValue({ workspaceId: WS, role: WorkspaceRole.MEMBER }),
      resolveAndAuthorize: jest.fn().mockResolvedValue(WS),
    } as any;
    const controller = new AgentInboxController(service, membership);
    const tools = new EmailOpsTools(
      membership,
      service,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, rows, controller, tools };
  }

  it.each([true, false])(
    'REST and MCP forward factual_correction=%s on single and bulk approval',
    async (value) => {
      const { service, controller, tools } = fronts();
      const single = jest
        .spyOn(service, 'approveAgentInboxItem')
        .mockResolvedValue({ inbox: {} as any, message: null });
      const bulk = jest.spyOn(service, 'bulkApproveAgentInboxItems').mockResolvedValue({} as any);
      await controller.approve(
        WS,
        user,
        'item-1',
        { note: 'Checked', factual_correction: value },
        WorkspaceRole.MEMBER,
      );
      await tools.approveAgentInboxItem(user, {
        item_id: 'item-1',
        note: 'Checked',
        factual_correction: value,
      });
      expect(single).toHaveBeenCalledTimes(2);
      expect(single).toHaveBeenNthCalledWith(
        1,
        WS,
        UID,
        'item-1',
        'Checked',
        undefined,
        false,
        WorkspaceRole.MEMBER,
        value,
      );
      expect(single).toHaveBeenNthCalledWith(
        2,
        WS,
        UID,
        'item-1',
        'Checked',
        undefined,
        false,
        WorkspaceRole.MEMBER,
        value,
      );
      await controller.bulkApprove(
        WS,
        user,
        { item_ids: ['item-1'], factual_correction: value },
        WorkspaceRole.MEMBER,
      );
      await tools.bulkApproveAgentInboxItems(user, {
        item_ids: ['item-1'],
        factual_correction: value,
      });
      expect(bulk).toHaveBeenCalledTimes(2);
      expect(bulk).toHaveBeenNthCalledWith(
        1,
        WS,
        UID,
        ['item-1'],
        null,
        undefined,
        false,
        WorkspaceRole.MEMBER,
        value,
      );
      expect(bulk).toHaveBeenNthCalledWith(
        2,
        WS,
        UID,
        ['item-1'],
        null,
        undefined,
        false,
        WorkspaceRole.MEMBER,
        value,
      );
    },
  );

  it('REST detail/list and MCP list expose the same persisted evidence', async () => {
    const { service, controller, tools } = fronts();
    await service.approveAgentInboxItem(
      WS,
      UID,
      'item-1',
      null,
      false,
      false,
      WorkspaceRole.MEMBER,
      false,
    );
    const evidence = {
      body_sha256: hash(DRAFT),
      sent_body_sha256: hash(DRAFT),
      edited_before_send: false,
      factual_correction: false,
    };
    expect(await controller.detail(WS, user, 'item-1')).toMatchObject({ item: evidence });
    expect(await controller.list(WS, user, { state: 'approved' })).toMatchObject({
      items: [evidence],
    });
    expect(await tools.listAgentInbox(user, { state: 'approved' })).toMatchObject({
      items: [evidence],
    });
  });

  it('advertises optional factual correction in both MCP approval schemas', () => {
    for (const name of ['approve_agent_inbox_item', 'bulk_approve_agent_inbox_items']) {
      const tool = MCP_MANIFEST_CATALOG.tools.find((entry) => entry.name === name)!;
      expect(tool.input_schema.properties).toHaveProperty('factual_correction', {
        type: 'boolean',
      });
      expect(tool.input_schema.required).not.toContain('factual_correction');
    }
  });
});
