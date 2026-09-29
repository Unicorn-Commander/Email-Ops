import { BadRequestException } from '@nestjs/common';
import { AgentInboxKind, AgentInboxState, EmailMessageStatus, EmailMode } from '@prisma/client';
import { createHash } from 'crypto';
import { EmailService } from './email.service';
import {
  agentSendKitRefusalReason,
  agentSendKitTemplateSha256,
  buildAgentSendKitDefinition,
  type AgentSendKitMessage,
} from './agent-send-kit';

const NOW = new Date('2026-09-29T15:00:00.000Z');
const TEMPLATE = '{first_name},\n\nYour secure link: {token}';

const definition = buildAgentSendKitDefinition({
  bodyTemplate: TEMPLATE,
  optionalLines: [0],
  subjects: ['Your secure link'],
  recipients: ['alice@example.com', 'bob@example.com'],
  fromAddress: 'outreach@example.org',
  capPerDay: 2,
});

function message(overrides: Partial<AgentSendKitMessage> = {}): AgentSendKitMessage {
  return {
    fromAddress: 'outreach@example.org',
    toAddress: 'alice@example.com',
    toAddresses: ['alice@example.com'],
    ccAddresses: [],
    bccAddresses: [],
    subject: 'RE: Your secure link',
    body: 'Ana,\n\nYour secure link: 0123456789abcdef',
    attachments: [],
    ...overrides,
  };
}

function kit(overrides: Partial<typeof definition> = {}) {
  return {
    ...definition,
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('personalised agent send-kit guard', () => {
  type RefusalCase = {
    message?: AgentSendKitMessage;
    kit?: ReturnType<typeof kit> | null;
    sentToday?: number;
    now?: Date;
  };
  const refusalCases: Array<[string, RefusalCase]> = [
    ['kit_missing', { kit: null }],
    ['kit_expired', { kit: kit({}), now: new Date('2026-10-02T00:00:00.000Z') }],
    ['from_mismatch', { message: message({ fromAddress: 'other@example.org' }) }],
    ['extra_recipients', { message: message({ toAddresses: ['alice@example.com', 'bob@example.com'] }) }],
    ['attachments_not_allowed', { message: message({ attachments: [{ name: 'x.pdf' }] }) }],
    ['recipient_not_in_kit', { message: message({ toAddress: 'carol@example.com', toAddresses: ['carol@example.com'] }) }],
    ['subject_not_in_kit', { message: message({ subject: 'Different subject' }) }],
    ['body_mismatch', { message: message({ body: 'No longer the approved body.' }) }],
    ['cap_reached', { sentToday: 2 }],
  ];

  it.each(refusalCases)('refuses with reason %s', (reason, input) => {
    expect(
      agentSendKitRefusalReason({
        message: input.message ?? message(),
        kit: input.kit === null ? null : input.kit ?? kit(),
        sentToday: input.sentToday ?? 0,
        now: input.now ?? NOW,
      }),
    ).toBe(reason);
  });

  it('accepts a valid personalised message and a single leading RE: subject prefix', () => {
    expect(agentSendKitRefusalReason({ message: message(), kit: kit(), sentToday: 1, now: NOW })).toBeNull();
  });

  it('accepts the optional greeting line when present and absent', () => {
    expect(agentSendKitRefusalReason({ message: message(), kit: kit(), sentToday: 0, now: NOW })).toBeNull();
    expect(
      agentSendKitRefusalReason({
        message: message({ body: 'Your secure link: 0123456789abcdef' }),
        kit: kit(),
        sentToday: 0,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('refuses a body with one extra character appended', () => {
    expect(
      agentSendKitRefusalReason({
        message: message({ body: 'Ana,\n\nYour secure link: 0123456789abcdef!' }),
        kit: kit(),
        sentToday: 0,
        now: NOW,
      }),
    ).toBe('body_mismatch');
  });

  it('accepts CRLF in the staged body after normalisation', () => {
    expect(
      agentSendKitRefusalReason({
        message: message({ body: 'Ana,\r\n\r\nYour secure link: 0123456789abcdef' }),
        kit: kit(),
        sentToday: 0,
        now: NOW,
      }),
    ).toBeNull();
  });

  it('refuses a token with only 15 hexadecimal characters', () => {
    expect(
      agentSendKitRefusalReason({
        message: message({ body: 'Ana,\n\nYour secure link: 0123456789abcde' }),
        kit: kit(),
        sentToday: 0,
        now: NOW,
      }),
    ).toBe('body_mismatch');
  });
});

describe('approve_send_kit and agent-inbox projections', () => {
  function serviceWithTx(tx: Record<string, unknown>): EmailService {
    const prisma = {
      withWorkspace: jest.fn((_workspace: string, _uid: string, fn: (value: unknown) => unknown) => fn(tx)),
    } as any;
    return new EmailService(prisma, {} as never, {} as never, {} as never);
  }

  it('refuses a wrong template_sha256 before writing the kit', async () => {
    const create = jest.fn();
    const tx = { agentSendKit: { findFirst: jest.fn(), create, update: jest.fn() } };
    const service = serviceWithTx(tx);
    await expect(
      service.approveSendKit('workspace-1', 'human-1', {
        kitId: 'kit-1',
        bodyTemplate: TEMPLATE,
        optionalLines: [0],
        subjects: ['Your secure link'],
        recipients: ['alice@example.com', 'bob@example.com'],
        fromAddress: 'outreach@example.org',
        capPerDay: 2,
        templateSha256: '0'.repeat(64),
        expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('stores hashed recipients and the canonical definition on human approval', async () => {
    const create = jest.fn().mockResolvedValue({ kitId: 'kit-1' });
    const tx = {
      agentSendKit: { findFirst: jest.fn().mockResolvedValue(null), create, update: jest.fn() },
    };
    const service = serviceWithTx(tx);
    const templateSha256 = agentSendKitTemplateSha256(definition);
    await service.approveSendKit('workspace-1', 'human-1', {
      kitId: 'kit-1',
      bodyTemplate: TEMPLATE,
      optionalLines: [0],
      subjects: ['Your secure link'],
      recipients: ['alice@example.com', 'bob@example.com'],
      fromAddress: 'outreach@example.org',
      capPerDay: 2,
      templateSha256,
      expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        templateSha256,
        bodyTemplate: TEMPLATE,
        placeholderRules: definition.placeholderRules,
        optionalLines: [0],
        subjects: ['Your secure link'],
        recipientHashes: definition.recipientHashes,
        fromAddress: 'outreach@example.org',
        capPerDay: 2,
      }),
    });
  });

  it('includes body_sha256, reply thread_id, and kit_id in list and single-item views', async () => {
    const body = 'Ana,\n\nYour secure link: 0123456789abcdef';
    const item = {
      id: 'item-1',
      messageId: 'message-1',
      kind: AgentInboxKind.EMAIL,
      payload: null,
      state: AgentInboxState.PENDING,
      draftedBy: 'agent-1',
      summary: 'Your secure link',
      reviewedByUcUid: null,
      reviewedAt: null,
      reviewNote: null,
      createdAt: NOW,
      message: {
        id: 'message-1',
        threadId: 'provider-thread-after-send',
        inReplyToThreadId: 'reply-thread-at-compose',
        kitId: 'kit-1',
        fromAddress: 'outreach@example.org',
        toAddress: 'alice@example.com',
        toAddresses: ['alice@example.com'],
        ccAddresses: [],
        bccAddresses: [],
        subject: 'Your secure link',
        body,
        preview: body,
        attachments: null,
        bodyHtml: null,
        status: EmailMessageStatus.PENDING_APPROVAL,
        mode: EmailMode.DRAFT,
        sentAt: null,
        createdAt: NOW,
      },
    };
    const tx = {
      agentInboxItem: {
        findMany: jest.fn().mockResolvedValue([item]),
        findFirst: jest.fn().mockResolvedValue(item),
      },
    };
    const service = serviceWithTx(tx);
    const expectedHash = createHash('sha256').update(body, 'utf8').digest('hex');
    const list = await service.listAgentInbox('workspace-1', 'human-1');
    const detail = await service.getAgentInboxItemDetail('workspace-1', 'human-1', 'item-1');

    expect(list[0]).toMatchObject({ body_sha256: expectedHash, thread_id: 'reply-thread-at-compose', kit_id: 'kit-1' });
    expect(detail).toMatchObject({
      body_sha256: expectedHash,
      thread_id: 'reply-thread-at-compose',
      kit_id: 'kit-1',
    });
  });

  it('binds the supplied definition to the server-computed canonical hash', () => {
    expect(agentSendKitTemplateSha256(definition)).toMatch(/^[0-9a-f]{64}$/);
  });
});
