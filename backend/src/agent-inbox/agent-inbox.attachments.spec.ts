import { NotFoundException } from '@nestjs/common';
import { AgentInboxController } from './agent-inbox.controller';
import { EmailService } from '../email/email.service';

const WS = 'workspace-1';
const USER = { id: 'user-1', __ucUid: 'user-1' } as any;

function response() {
  return { set: jest.fn(), send: jest.fn() } as any;
}

function serviceWith(attachments: unknown[], mailboxAccountId: string | null = 'mailbox-1') {
  const message = {
    id: 'message-1', mailboxAccountId, attachments, threadId: null,
    subject: 'Draft', fromAddress: 'sender@example.com', toAddress: 'reader@example.com',
    toAddresses: ['reader@example.com'], ccAddresses: [], bccAddresses: [],
    body: 'Hello', bodyHtml: null, status: 'PENDING_APPROVAL', mode: 'DRAFT',
    sentAt: null, createdAt: new Date('2026-11-09T12:00:00Z'),
  };
  const item = {
    id: 'item-1', workspaceId: WS, messageId: message.id, message,
    state: 'PENDING', draftedBy: 'agent', summary: null, reviewedByUcUid: null,
    reviewedAt: null, reviewNote: null, createdAt: new Date('2026-11-09T12:00:00Z'),
    payload: { nested: { content_base64: 'SGVsbG8=' } },
  };
  const findFirst = jest.fn(async ({ where }: any) => where.workspaceId === WS && where.id === item.id ? item : null);
  const tx = {
    membership: { findUnique: jest.fn().mockResolvedValue({ role: 'OWNER', status: 'ACTIVE', mailboxScope: 'ALL' }) },
    mailboxAccount: { findMany: jest.fn().mockResolvedValue([{ id: 'mailbox-1' }]) },
    agentInboxItem: { findFirst },
    outboundAttachment: { findFirst: jest.fn() },
  };
  const service = Object.create(EmailService.prototype) as EmailService;
  (service as any).prisma = { withWorkspace: async (_ws: string, _uid: string, fn: (tx: any) => Promise<unknown>) => fn(tx) };
  return { service, tx, findFirst };
}

describe('agent inbox attachment read', () => {
  it('serves an inline base64 row with safe headers and hides bytes from detail JSON', async () => {
    const { service } = serviceWith([{ filename: 'report.txt', content_type: 'text/plain', content_base64: 'SGVsbG8=' }]);
    const detail = await service.getAgentInboxItemDetail(WS, 'user-1', 'item-1');
    expect(JSON.stringify(detail)).not.toMatch(/content_base64|contentBase64|SGVsbG8=/);
    expect(detail?.message?.attachments[0]).toMatchObject({ index: 0, downloadable: true });
    const controller = new AgentInboxController(service, {} as any);
    const res = response();
    await controller.attachment(WS, USER, 'item-1', '0', res);
    expect(res.send.mock.calls[0][0]).toEqual(Buffer.from('Hello'));
    expect(res.set.mock.calls[0][0]).toMatchObject({
      'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'private, no-store',
    });
  });

  it('reads a blob through the existing mailbox download path', async () => {
    const { service } = serviceWith([{ blob_id: 'blob-1', name: 'photo.png', type: 'image/png' }]);
    const download = jest.fn().mockResolvedValue({ data: Buffer.from('pixels'), contentType: 'image/png' });
    service.downloadAttachment = download;
    const bytes = await service.getAgentInboxAttachment(WS, 'user-1', 'item-1', 0);
    expect(download).toHaveBeenCalledWith(WS, 'user-1', 'mailbox-1', 'blob-1');
    expect(bytes?.data).toEqual(Buffer.from('pixels'));
  });

  it('reads a document only from the staged message mailbox', async () => {
    const { service, tx } = serviceWith([{ documentId: 'doc-1' }]);
    tx.outboundAttachment.findFirst.mockResolvedValue({
      bytes: Buffer.from('document'), mimeType: 'application/pdf', filename: 'report.pdf',
    });
    const bytes = await service.getAgentInboxAttachment(WS, 'user-1', 'item-1', 0);
    expect(tx.outboundAttachment.findFirst).toHaveBeenCalledWith({
      where: { id: 'doc-1', workspaceId: WS, mailboxId: 'mailbox-1' },
      select: { bytes: true, mimeType: true, filename: true },
    });
    expect(bytes?.data).toEqual(Buffer.from('document'));
  });

  it('returns 404 for an out-of-range index and a foreign item', async () => {
    const { service } = serviceWith([{ content_base64: 'YQ==', type: 'text/plain' }]);
    const controller = new AgentInboxController(service, {} as any);
    await expect(controller.attachment(WS, USER, 'item-1', '1', response())).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.attachment('foreign-workspace', USER, 'item-1', '0', response())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the detail mailbox scope when looking up the item', async () => {
    const { service, tx, findFirst } = serviceWith([{ content_base64: 'YQ==' }], 'other-mailbox');
    tx.membership.findUnique.mockResolvedValue({ role: 'MEMBER', status: 'ACTIVE', mailboxScope: 'OWNED' });
    tx.mailboxAccount.findMany.mockResolvedValue([{ id: 'owned-mailbox' }]);
    findFirst.mockResolvedValue(null);
    const result = await service.getAgentInboxAttachment(WS, 'user-1', 'item-1', 0);
    expect(result).toBeNull();
    expect(findFirst.mock.calls[0][0].where.OR).toContainEqual({
      message: { is: { mailboxAccountId: { in: ['owned-mailbox'] } } },
    });
  });

  it('forces SVG and HTML to download as octet-stream', async () => {
    for (const type of ['image/svg+xml', 'text/html']) {
      const { service } = serviceWith([{ name: '../unsafe.svg', type, contentBase64: 'PHN2Zy8+' }]);
      const res = response();
      await new AgentInboxController(service, {} as any).attachment(WS, USER, 'item-1', '0', res);
      expect(res.set.mock.calls[0][0]).toMatchObject({ 'Content-Type': 'application/octet-stream' });
      expect(res.set.mock.calls[0][0]['Content-Disposition']).toMatch(/^attachment; filename="unsafe.svg"/);
    }
  });

  it('sanitizes the filename and encodes Unicode in filename*', async () => {
    const { service } = serviceWith([{ filename: '../résumé (final).pdf', type: 'application/pdf', content_base64: 'YQ==' }]);
    const res = response();
    await new AgentInboxController(service, {} as any).attachment(WS, USER, 'item-1', '0', res);
    expect(res.set.mock.calls[0][0]['Content-Disposition']).toBe(
      `inline; filename="r_sum_ (final).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29.pdf`,
    );
  });
});
