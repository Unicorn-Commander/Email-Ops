import { BadRequestException, NotFoundException, NotImplementedException } from '@nestjs/common';
import { MessageDisposition, User } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { DispositionService } from '../mail-triage/disposition.service';
import { EmailService } from '../email/email.service';
import { MailController } from './mail.controller';

/**
 * MailController (webmail wave): prove the new routes delegate with the
 * resolved workspace + acting sub and honor the FE contract semantics —
 * comma-split to_address, q/offset passthrough, bulk succeeded/failed id
 * arrays, blob 404/501 (never 500), and the Content-Disposition headers on
 * the download. Services are mocked (no DB / engine).
 */
describe('MailController (webmail wave)', () => {
  const WS = '0190a000-7e57-7000-8000-0000000000a1';

  function user(): User {
    const u: WithWorkspaceClaim = {
      id: 'local-1',
      email: 'aaron@magicunicorn.tech',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      keycloakId: 'kc-aaron',
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __ucUid: 'kc-aaron',
      __entitlements: [],
      __workspaceClaim: WS,
    };
    return u as User;
  }

  function make(email: Partial<jest.Mocked<EmailService>>, disposition: Partial<jest.Mocked<DispositionService>> = {}) {
    return new MailController(
      email as unknown as EmailService,
      disposition as unknown as DispositionService,
    );
  }

  it('GET :mailboxId/threads passes q + offset (and clamps limit) through to the service', async () => {
    const listMailboxInbox = jest.fn().mockResolvedValue([]);
    await make({ listMailboxInbox }).threads(WS, user(), 'mb-1', '500', 'archive', 'invoice', '25');
    expect(listMailboxInbox).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1', 200, 'archive', 'invoice', 25);
  });

  it('GET threads/aggregate delegates with folder/limit/q/offset and echoes count', async () => {
    const listAggregateInbox = jest
      .fn()
      .mockResolvedValue([{ id: 't1', mailbox_id: 'mb-1', mailbox_address: 'hq@x.test' }]);
    const out = await make({ listAggregateInbox }).aggregate(WS, user(), '10', 'inbox', 'hello', '0');
    expect(listAggregateInbox).toHaveBeenCalledWith(WS, 'kc-aaron', 'inbox', 10, 'hello', 0);
    expect(out.count).toBe(1);
    expect(out.threads[0]).toMatchObject({ mailbox_id: 'mb-1', mailbox_address: 'hq@x.test' });
  });

  it('GET counts returns { mailboxes } from the service', async () => {
    const getWorkspaceMailCounts = jest.fn().mockResolvedValue([
      { mailbox_id: 'mb-1', address: 'hq@x.test', inbox_unread: 3, inbox_total: 9 },
      { mailbox_id: 'mb-2', address: 'dead@x.test', inbox_unread: 0, inbox_total: 0, error: true },
    ]);
    const out = await make({ getWorkspaceMailCounts }).counts(WS, user());
    expect(getWorkspaceMailCounts).toHaveBeenCalledWith(WS, 'kc-aaron');
    expect(out.mailboxes).toHaveLength(2);
    expect(out.mailboxes[1]).toMatchObject({ error: true, inbox_unread: 0 });
  });

  it('PUT .../read delegates to setThreadReadState', async () => {
    const setThreadReadState = jest.fn().mockResolvedValue({ thread_id: 't1', read: true, updated: true });
    const out = await make({ setThreadReadState }).setRead(WS, user(), 'mb-1', 't1', { read: true });
    expect(setThreadReadState).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1', 't1', true);
    expect(out).toEqual({ thread_id: 't1', read: true, updated: true });
  });

  describe('POST threads/bulk', () => {
    it('disposition actions reuse DispositionService per thread and return succeeded ids', async () => {
      const setDisposition = jest.fn().mockResolvedValue({ thread_id: 'x', disposition: 'ARCHIVE' });
      const out = await make({}, { setDisposition }).bulk(WS, user(), {
        thread_ids: ['t1', 't2'],
        action: 'archive',
      });
      expect(setDisposition).toHaveBeenCalledTimes(2);
      expect(setDisposition).toHaveBeenCalledWith(WS, 'kc-aaron', 't1', MessageDisposition.ARCHIVE);
      expect(out).toEqual({ succeeded: ['t1', 't2'], failed: [] });
    });

    it('one failing thread lands in failed[] without failing the batch', async () => {
      const setDisposition = jest
        .fn()
        .mockResolvedValueOnce({ thread_id: 't1' })
        .mockRejectedValueOnce(new Error('boom'));
      const out = await make({}, { setDisposition }).bulk(WS, user(), {
        thread_ids: ['t1', 't2'],
        action: 'trash',
      });
      expect(out).toEqual({ succeeded: ['t1'], failed: ['t2'] });
    });

    it('read/unread routes through setThreadReadAcrossMailboxes with the right flag', async () => {
      const setThreadReadAcrossMailboxes = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const out = await make({ setThreadReadAcrossMailboxes }).bulk(WS, user(), {
        thread_ids: ['t1', 't2'],
        action: 'unread',
      });
      expect(setThreadReadAcrossMailboxes).toHaveBeenCalledWith(WS, 'kc-aaron', 't1', false);
      expect(out).toEqual({ succeeded: ['t1'], failed: ['t2'] });
    });
  });

  describe('GET .../blobs/:blobId', () => {
    function fakeRes() {
      return { set: jest.fn(), send: jest.fn() } as any;
    }

    it('404s (never 500) when the blob is unknown or the engine cannot serve it', async () => {
      const downloadAttachment = jest.fn().mockResolvedValue(null);
      await expect(
        make({ downloadAttachment }).downloadBlob(WS, user(), 'mb-1', 'blob-x', fakeRes(), 'f.pdf', 'application/pdf'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('streams the bytes with Content-Type from the query and a filename Content-Disposition', async () => {
      const data = Buffer.from('PDFDATA');
      const downloadAttachment = jest.fn().mockResolvedValue({ data, contentType: 'application/pdf' });
      const res = fakeRes();
      await make({ downloadAttachment }).downloadBlob(WS, user(), 'mb-1', 'blob-1', res, 'report q3.pdf', 'application/pdf');
      expect(downloadAttachment).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1', 'blob-1');
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'application/pdf',
          'Content-Disposition': expect.stringContaining('filename="report q3.pdf"'),
          'Content-Length': String(data.length),
        }),
      );
      expect(res.send).toHaveBeenCalledWith(data);
    });

    it('defaults Content-Type to application/octet-stream when no type param', async () => {
      const downloadAttachment = jest.fn().mockResolvedValue({ data: Buffer.from('x'), contentType: null });
      const res = fakeRes();
      await make({ downloadAttachment }).downloadBlob(WS, user(), 'mb-1', 'blob-1', res, undefined, undefined);
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({ 'Content-Type': 'application/octet-stream' }),
      );
    });
  });

  describe('POST .../attachments', () => {
    it('400s without a file part', async () => {
      await expect(make({}).uploadAttachment(WS, user(), 'mb-1', undefined)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('501s (never 500) when the engine cannot accept uploads', async () => {
      const uploadAttachment = jest.fn().mockResolvedValue(null);
      await expect(
        make({ uploadAttachment }).uploadAttachment(WS, user(), 'mb-1', {
          buffer: Buffer.from('x'),
          originalname: 'f.txt',
          mimetype: 'text/plain',
          size: 1,
        }),
      ).rejects.toBeInstanceOf(NotImplementedException);
    });

    it('returns { blob_id, name, type, size } on success', async () => {
      const uploadAttachment = jest
        .fn()
        .mockResolvedValue({ blob_id: 'b1', name: 'f.txt', type: 'text/plain', size: 1 });
      const out = await make({ uploadAttachment }).uploadAttachment(WS, user(), 'mb-1', {
        buffer: Buffer.from('x'),
        originalname: 'f.txt',
        mimetype: 'text/plain',
        size: 1,
      });
      expect(uploadAttachment).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1', expect.any(Buffer), 'text/plain', 'f.txt');
      expect(out).toEqual({ blob_id: 'b1', name: 'f.txt', type: 'text/plain', size: 1 });
    });
  });

  describe('POST .../compose', () => {
    it('splits a comma-joined to_address into toAddresses and keeps the first as toAddress', async () => {
      const composeEmail = jest.fn().mockResolvedValue({ id: 'm1' });
      await make({ composeEmail }).compose(WS, user(), 'mb-1', {
        to_address: ' a@acme.test , b@acme.test ',
        subject: 's',
        body: 'b',
      } as never);
      const input = composeEmail.mock.calls[0][2];
      expect(input.toAddress).toBe('a@acme.test');
      expect(input.toAddresses).toEqual(['a@acme.test', 'b@acme.test']);
      expect(input.fromMailboxAccountId).toBe('mb-1');
    });

    it('a single recipient keeps toAddresses undefined (back-compat shape)', async () => {
      const composeEmail = jest.fn().mockResolvedValue({ id: 'm1' });
      await make({ composeEmail }).compose(WS, user(), 'mb-1', {
        to_address: 'a@acme.test',
      } as never);
      const input = composeEmail.mock.calls[0][2];
      expect(input.toAddress).toBe('a@acme.test');
      expect(input.toAddresses).toBeUndefined();
    });

    it('400s on a malformed address in the comma list', async () => {
      await expect(
        make({ composeEmail: jest.fn() }).compose(WS, user(), 'mb-1', {
          to_address: 'a@acme.test, not-an-address',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('carries cc/bcc/attachments/in_reply_to/references through to ComposeInput', async () => {
      const composeEmail = jest.fn().mockResolvedValue({ id: 'm1' });
      await make({ composeEmail }).compose(WS, user(), 'mb-1', {
        to_address: 'a@acme.test',
        cc: ['c@acme.test'],
        bcc: ['d@acme.test'],
        attachments: [{ blob_id: 'b1', name: 'f.pdf', type: 'application/pdf' }],
        in_reply_to: 'internal-msg-id-1',
        references: ['ref-1'],
      } as never);
      const input = composeEmail.mock.calls[0][2];
      expect(input.cc).toEqual(['c@acme.test']);
      expect(input.bcc).toEqual(['d@acme.test']);
      expect(input.attachments).toEqual([{ blob_id: 'b1', name: 'f.pdf', type: 'application/pdf' }]);
      expect(input.inReplyToMessageId).toBe('internal-msg-id-1');
      expect(input.references).toEqual(['ref-1']);
    });

    it('400s when an attachment ref has no blob_id', async () => {
      await expect(
        make({ composeEmail: jest.fn() }).compose(WS, user(), 'mb-1', {
          to_address: 'a@acme.test',
          attachments: [{ name: 'f.pdf', type: 'application/pdf' }],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
