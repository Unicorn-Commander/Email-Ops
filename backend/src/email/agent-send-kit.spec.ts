import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgentInboxKind, AgentInboxState, AgentSendKitState, EmailMessageStatus, EmailMode } from '@prisma/client';
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

function kit(
  overrides: Partial<typeof definition> & { state?: 'PROPOSED' | 'APPROVED' | 'REJECTED' } = {},
) {
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

  it('refuses proposed and rejected kits with distinct guard reasons', () => {
    expect(
      agentSendKitRefusalReason({ message: message(), kit: kit({ state: 'PROPOSED' }), sentToday: 0, now: NOW }),
    ).toBe('kit_not_approved');
    expect(
      agentSendKitRefusalReason({ message: message(), kit: kit({ state: 'REJECTED' }), sentToday: 0, now: NOW }),
    ).toBe('kit_rejected');
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
  // The service checks expiry against the real clock while the fixtures use fixed dates around NOW.
  // Pin Date to NOW (only Date; timers and microtasks stay real) so the suite does not expire with the calendar.
  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'hrtime'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function serviceWithTx(tx: Record<string, unknown>): EmailService {
    const prisma = {
      withWorkspace: jest.fn((_workspace: string, _uid: string, fn: (value: unknown) => unknown) => fn(tx)),
    } as any;
    return new EmailService(prisma, {} as never, {} as never, {} as never);
  }

  function storedKit(overrides: Record<string, unknown> = {}) {
    return {
      kitId: 'kit-1',
      workspaceId: 'workspace-1',
      state: AgentSendKitState.PROPOSED,
      title: 'Secure links',
      proposedBy: 'agent-1',
      proposedAt: NOW,
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      note: null,
      templateSha256: agentSendKitTemplateSha256(definition),
      bodyTemplate: definition.bodyTemplate,
      placeholderRules: definition.placeholderRules,
      optionalLines: definition.optionalLines,
      subjects: definition.subjects,
      recipients: definition.recipients,
      recipientHashes: definition.recipientHashes,
      fromAddress: definition.fromAddress,
      capPerDay: definition.capPerDay,
      expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function proposalInput(overrides: Record<string, unknown> = {}) {
    return {
      kitId: 'kit-1',
      title: 'Secure links',
      bodyTemplate: TEMPLATE,
      optionalLines: [0],
      subjects: ['Your secure link'],
      recipients: ['ALICE@example.com', 'bob@example.com'],
      fromAddress: 'outreach@example.org',
      capPerDay: 2,
      expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('proposes idempotently and retains lower-cased recipients plus the hash', async () => {
    const existing = storedKit();
    const create = jest.fn();
    const update = jest.fn();
    const tx = {
      agentSendKit: { findFirst: jest.fn().mockResolvedValue(existing), create, update },
      emailMessage: { count: jest.fn().mockResolvedValue(0) },
    };
    const out = await serviceWithTx(tx).proposeSendKit('workspace-1', 'agent-1', proposalInput());
    expect(out).toMatchObject({ kit_id: 'kit-1', state: 'PROPOSED', template_sha256: existing.templateSha256, replaced: false });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('replaces a different definition while the proposal is still PROPOSED and says so', async () => {
    const existing = storedKit({ bodyTemplate: 'Old {token}', templateSha256: 'f'.repeat(64) });
    const replaced = storedKit({ title: 'New secure links' });
    const update = jest.fn().mockResolvedValue(replaced);
    const tx = {
      agentSendKit: { findFirst: jest.fn().mockResolvedValue(existing), create: jest.fn(), update },
      emailMessage: { count: jest.fn().mockResolvedValue(0) },
    };
    const out = await serviceWithTx(tx).proposeSendKit('workspace-1', 'agent-2', proposalInput({ title: 'New secure links' }));
    expect(out.replaced).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { kitId: 'kit-1' }, data: expect.objectContaining({ state: AgentSendKitState.PROPOSED, proposedBy: 'agent-2' }) }));
  });

  it('refuses a different definition after approval', async () => {
    const tx = {
      agentSendKit: { findFirst: jest.fn().mockResolvedValue(storedKit({ state: AgentSendKitState.APPROVED })), create: jest.fn(), update: jest.fn() },
      emailMessage: { count: jest.fn().mockResolvedValue(0) },
    };
    await expect(
      serviceWithTx(tx).proposeSendKit('workspace-1', 'agent-1', proposalInput({ title: 'Changed title' })),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.agentSendKit.update).not.toHaveBeenCalled();
  });

  it('approves a proposed kit by hash only and refuses a hash mismatch, wrong state, and expiry', async () => {
    const update = jest.fn().mockResolvedValue(storedKit({ state: AgentSendKitState.APPROVED, approvedBy: 'human-1', approvedAt: NOW }));
    const tx = {
      agentSendKit: { findFirst: jest.fn().mockResolvedValue(storedKit()), create: jest.fn(), update },
      emailMessage: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = serviceWithTx(tx);
    await expect(service.approveSendKit('workspace-1', 'human-1', { kitId: 'kit-1', templateSha256: '0'.repeat(64) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.approveSendKit('workspace-1', 'human-1', { kitId: 'kit-1', templateSha256: storedKit().templateSha256 })).resolves.toMatchObject({ state: 'APPROVED' });

    tx.agentSendKit.findFirst.mockResolvedValue(storedKit({ state: AgentSendKitState.APPROVED }));
    await expect(service.approveSendKit('workspace-1', 'human-1', { kitId: 'kit-1', templateSha256: storedKit().templateSha256 })).rejects.toThrow('Only a proposed');
    tx.agentSendKit.findFirst.mockResolvedValue(storedKit({ expiresAt: new Date('2026-09-01T00:00:00.000Z') }));
    await expect(service.approveSendKit('workspace-1', 'human-1', { kitId: 'kit-1', templateSha256: storedKit().templateSha256 })).rejects.toThrow('expired');
  });

  it('rejects a proposed kit with an audit note', async () => {
    const updated = storedKit({ state: AgentSendKitState.REJECTED, rejectedBy: 'human-1', rejectedAt: NOW, note: 'Copy is not ready.' });
    const tx = {
      agentSendKit: { findFirst: jest.fn().mockResolvedValue(storedKit()), update: jest.fn().mockResolvedValue(updated) },
      emailMessage: { count: jest.fn().mockResolvedValue(0) },
    };
    await expect(serviceWithTx(tx).rejectSendKit('workspace-1', 'human-1', 'kit-1', 'Copy is not ready.')).resolves.toMatchObject({ state: 'REJECTED', note: 'Copy is not ready.' });
    expect(tx.agentSendKit.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: AgentSendKitState.REJECTED, rejectedBy: 'human-1', note: 'Copy is not ready.' }) }));
  });

  it('returns list and get shapes with recipient count and sent_today', async () => {
    const row = storedKit();
    const tx = {
      agentSendKit: { findMany: jest.fn().mockResolvedValue([row]), findFirst: jest.fn().mockResolvedValue(row) },
      emailMessage: { count: jest.fn().mockResolvedValue(1) },
    };
    const service = serviceWithTx(tx);
    await expect(service.listSendKits('workspace-1', 'human-1')).resolves.toMatchObject({
      0: expect.objectContaining({ id: 'kit-1', recipient_count: 2, sent_today: 1 }),
    });
    await expect(service.getSendKit('workspace-1', 'human-1', 'kit-1')).resolves.toMatchObject({
      kit_id: 'kit-1', recipients: ['alice@example.com', 'bob@example.com'], body_template: TEMPLATE,
    });
  });

  it('adds proposed kits to the pending inbox count', async () => {
    const tx = {
      agentInboxItem: { count: jest.fn().mockResolvedValue(3) },
      agentSendKit: { count: jest.fn().mockResolvedValue(2) },
    };
    await expect(serviceWithTx(tx).countAgentInboxPending('workspace-1', 'human-1')).resolves.toBe(5);
  });

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
