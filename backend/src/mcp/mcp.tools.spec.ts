import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MessageDisposition, WorkspaceRole } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { BULK_DISPOSITION_CONCURRENCY, EmailOpsTools, MCP_ATTACHMENT_MAX_BYTES } from './mcp.tools';
import { EmailService } from '../email/email.service';
import { AgentsService } from '../agents/agents.service';
import { EmailHealthService } from '../email-health/email-health.service';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { MailboxAccountsService } from '../mailbox-accounts/mailbox-accounts.service';
import { DispositionService } from '../mail-triage/disposition.service';
import { SenderPolicyService } from '../mail-triage/sender-policy.service';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { MailDomainService } from '../mail-engine-admin/mail-domain.service';

describe('EmailOpsTools', () => {
  let tools: EmailOpsTools;
  let membership: MembershipService;
  let mailDomains: MailDomainService;
  let admin: MailEngineAdminPort;

  beforeEach(() => {
    membership = {
      resolveWithRole: jest.fn(),
    } as any;
    mailDomains = {
      bindDomain: jest.fn(),
      assertWorkspaceOwnsDomain: jest.fn(),
      domainOf: jest.fn(),
    } as any;
    admin = {
      isConfigured: jest.fn(),
      ensureDomain: jest.fn(),
      removeDomain: jest.fn(),
      setQuota: jest.fn(),
      removeAccount: jest.fn(),
    } as any;

    tools = new EmailOpsTools(
      membership as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      admin,
      mailDomains,
    );
  });

  describe('thread source mailbox', () => {
    function threadTools(messages: unknown[] = []) {
      const email = { listThreadMessages: jest.fn().mockResolvedValue(messages) };
      const membership = { resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1') };
      const t = new EmailOpsTools(membership as any, email as any,
        {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
      return { t, email, membership };
    }
    it.each(['getThread', 'listThreadMessages'] as const)(
      '%s errors for an empty implicit-default lookup', async (method) => {
        const { t } = threadTools();
        await expect(t[method]({} as any, { thread_id: 'external-thread' }))
          .rejects.toThrow('Pass mailbox_id from search_mail or list_threads');
      },
    );
    it.each(['getThread', 'listThreadMessages'] as const)(
      '%s passes explicit source and preserves empty scoped responses', async (method) => {
        const { t, email } = threadTools();
        const result = await t[method]({} as any, { thread_id: 'external', mailbox_id: 'mb-1' });
        expect(result.messages).toEqual([]);
        expect(email.listThreadMessages).toHaveBeenCalledWith('ws-1', '', 'external', 'mb-1');
      },
    );
    it('keeps existing successful default-mailbox reads', async () => {
      const { t } = threadTools([{ id: 'message' }]);
      expect(await t.getThread({} as any, { thread_id: 'local' }))
        .toEqual({ messages: [{ id: 'message' }], count: 1 });
    });
    it('rejects workspace resolution before mail access', async () => {
      const { t, email, membership } = threadTools();
      membership.resolveAndAuthorize.mockRejectedValue(new ForbiddenException());
      await expect(t.getThread({} as any, { thread_id: 'external', mailbox_id: 'other' }))
        .rejects.toThrow(ForbiddenException);
      expect(email.listThreadMessages).not.toHaveBeenCalled();
    });
  });

  describe('ensureMailDomain', () => {
    it('throws ForbiddenException for non-OWNER role', async () => {
      (membership.resolveWithRole as jest.Mock).mockResolvedValue({
        workspaceId: 'ws-1',
        role: WorkspaceRole.MEMBER,
      });

      await expect(
        tools.ensureMailDomain({} as any, { workspace_id: 'ws-1', domain: 'example.com' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('proceeds for OWNER role', async () => {
      (membership.resolveWithRole as jest.Mock).mockResolvedValue({
        workspaceId: 'ws-1',
        role: WorkspaceRole.OWNER,
      });
      (mailDomains.bindDomain as jest.Mock).mockResolvedValue({ domain: 'example.com' });
      (admin.isConfigured as jest.Mock).mockReturnValue(true);
      (admin.ensureDomain as jest.Mock).mockResolvedValue({ provisioned: true });

      const result = await tools.ensureMailDomain({} as any, { workspace_id: 'ws-1', domain: 'example.com' });
      expect(result.status).toBe('ok');
    });
  });

  describe('setMailboxQuota', () => {
    it('throws ForbiddenException for non-OWNER role', async () => {
      (membership.resolveWithRole as jest.Mock).mockResolvedValue({
        workspaceId: 'ws-1',
        role: WorkspaceRole.MEMBER,
      });

      await expect(
        tools.setMailboxQuota({} as any, { workspace_id: 'ws-1', address: 'user@example.com' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('proceeds for OWNER role', async () => {
      (membership.resolveWithRole as jest.Mock).mockResolvedValue({
        workspaceId: 'ws-1',
        role: WorkspaceRole.OWNER,
      });
      (mailDomains.domainOf as jest.Mock).mockReturnValue('example.com');
      (mailDomains.assertWorkspaceOwnsDomain as jest.Mock).mockResolvedValue(undefined);
      (admin.isConfigured as jest.Mock).mockReturnValue(true);
      (admin.setQuota as jest.Mock).mockResolvedValue({ provisioned: true });

      const result = await tools.setMailboxQuota({} as any, { workspace_id: 'ws-1', address: 'user@example.com' });
      expect(result.status).toBe('ok');
    });
  });

  describe('searchMail — honest capability signal on connected accounts', () => {
    function toolsWith(email: Partial<EmailService>): EmailOpsTools {
      const m = { resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1') } as any;
      return new EmailOpsTools(
        m,
        email as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    }

    it('single mailbox: surfaces search_supported=false so empty threads is not read as "no matches"', async () => {
      const email: Partial<EmailService> = {
        listMailboxInboxPage: jest.fn().mockResolvedValue({
          threads: [],
          nextPageToken: null,
          hasMore: false,
          pagingMode: 'page_token',
          searchSupported: false, // e.g. a Microsoft account handed an operator query it can't express
          reason: null,
        }),
      };
      const t = toolsWith(email);
      const res = await t.searchMail({} as any, {
        workspace_id: 'ws-1',
        mailbox_id: 'mb-ms',
        q: 'is:flagged',
      });
      expect(res.search_supported).toBe(false);
      expect(res.threads).toEqual([]);
      expect(res.count).toBe(0);
      // it must NOT silently fall back to the unfiltered aggregate path
      expect(email.listMailboxInboxPage).toHaveBeenCalledTimes(1);
    });

    it('single mailbox: search_supported=true when the provider honoured the filter', async () => {
      const email: Partial<EmailService> = {
        listMailboxInboxPage: jest.fn().mockResolvedValue({
          threads: [{ id: 't1' }],
          nextPageToken: 'nx',
          hasMore: true,
          pagingMode: 'page_token',
          searchSupported: true,
          reason: null,
        }),
      };
      const t = toolsWith(email);
      const res = await t.searchMail({} as any, { workspace_id: 'ws-1', mailbox_id: 'mb-g', q: 'invoice' });
      expect(res.search_supported).toBe(true);
      expect(res.has_more).toBe(true);
      expect(res.next_page_token).toBe('nx');
      expect(res.count).toBe(1);
    });

    it('unified: aggregate search_supported=false when any mailbox could not filter', async () => {
      const email: Partial<EmailService> = {
        listAggregateInboxPage: jest.fn().mockResolvedValue({
          threads: [{ id: 't1' }],
          searchSupported: false,
          hasMore: false,
        }),
      };
      const t = toolsWith(email);
      const res = await t.searchMail({} as any, { workspace_id: 'ws-1', q: 'from:a@b.com' });
      expect(res.search_supported).toBe(false);
      expect(res.next_page_token).toBeNull();
      expect(email.listAggregateInboxPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('set_disposition / bulk_disposition — real moves, honest failures', () => {
    function toolsWith(email: Partial<EmailService>): EmailOpsTools {
      const m = { resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1') } as any;
      return new EmailOpsTools(
        m,
        email as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        // DispositionService slot stays empty ON PURPOSE: any call into the
        // overlay-only path would throw — the tools must go through EmailService.
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    }

    const view = (threadId: string, over: Partial<{ moved: boolean; viewEffective: boolean }> = {}) => ({
      thread_id: threadId,
      disposition: MessageDisposition.TRASH,
      set_by_uc_uid: '',
      set_by_agent_key: null,
      updated_at: new Date().toISOString(),
      moved: true,
      viewEffective: false,
      ...over,
    });

    it('set_disposition delegates to applyThreadDisposition; a real move → status ok', async () => {
      const email: Partial<EmailService> = {
        applyThreadDisposition: jest.fn().mockResolvedValue(view('t1', { moved: true })),
      };
      const t = toolsWith(email);
      const res = await t.setDisposition({} as any, {
        workspace_id: 'ws-1',
        thread_id: 't1',
        disposition: 'TRASH',
      });
      expect(res.status).toBe('ok');
      expect(email.applyThreadDisposition).toHaveBeenCalledWith(
        'ws-1',
        '',
        't1',
        MessageDisposition.TRASH,
        { agentKey: null },
      );
    });

    it('set_disposition: external thread that could not be moved → status failed + reason (never a fake ok)', async () => {
      const email: Partial<EmailService> = {
        applyThreadDisposition: jest
          .fn()
          .mockResolvedValue(view('t-ext', { moved: false, viewEffective: false })),
      };
      const t = toolsWith(email);
      const res = await t.setDisposition({} as any, {
        workspace_id: 'ws-1',
        thread_id: 't-ext',
        disposition: 'TRASH',
      });
      expect(res.status).toBe('failed');
      expect(res.reason).toBe('provider_move_failed');
    });

    it('set_disposition: sovereign engine-dormant (moved:false but viewEffective:true) → ok (degrade-clean)', async () => {
      const email: Partial<EmailService> = {
        applyThreadDisposition: jest
          .fn()
          .mockResolvedValue(view('t-sov', { moved: false, viewEffective: true })),
      };
      const t = toolsWith(email);
      const res = await t.setDisposition({} as any, {
        workspace_id: 'ws-1',
        thread_id: 't-sov',
        disposition: 'ARCHIVE',
      });
      expect(res.status).toBe('ok');
    });

    it('bulk_disposition: mixed batch — moved → succeeded; external-unmoved + rejection → failed (isolation)', async () => {
      const email: Partial<EmailService> = {
        applyThreadDisposition: jest.fn().mockImplementation(async (_ws, _uid, threadId) => {
          if (threadId === 'a') return view('a', { moved: true });
          if (threadId === 'b') return view('b', { moved: false, viewEffective: false });
          throw new Error('provider 500'); // c — must not fail the batch
        }),
      };
      const t = toolsWith(email);
      const res = await t.bulkDisposition({} as any, {
        workspace_id: 'ws-1',
        thread_ids: ['a', 'b', 'c'],
        disposition: 'TRASH',
      });
      expect(res.succeeded).toEqual(['a']);
      expect(res.failed).toEqual(['b', 'c']);
      expect(email.applyThreadDisposition).toHaveBeenCalledTimes(3);
    });

    it('bulk_disposition: sovereign engine-dormant threads (viewEffective:true) count as succeeded', async () => {
      const email: Partial<EmailService> = {
        applyThreadDisposition: jest
          .fn()
          .mockResolvedValue(view('s1', { moved: false, viewEffective: true })),
      };
      const t = toolsWith(email);
      const res = await t.bulkDisposition({} as any, {
        workspace_id: 'ws-1',
        thread_ids: ['s1', 's2'],
        disposition: 'ARCHIVE',
      });
      expect(res.succeeded).toEqual(['s1', 's2']);
      expect(res.failed).toEqual([]);
    });

    it('bulk_disposition caps the provider fan-out (≤ BULK_DISPOSITION_CONCURRENCY in flight)', async () => {
      let inFlight = 0;
      let peak = 0;
      const email: Partial<EmailService> = {
        applyThreadDisposition: jest.fn().mockImplementation(async (_ws, _uid, threadId) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return view(threadId, { moved: true });
        }),
      };
      const t = toolsWith(email);
      const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
      const res = await t.bulkDisposition({} as any, {
        workspace_id: 'ws-1',
        thread_ids: ids,
        disposition: 'TRASH',
      });
      expect(res.succeeded).toEqual(ids);
      expect(peak).toBeLessThanOrEqual(BULK_DISPOSITION_CONCURRENCY);
    });
  });

  describe('getAttachment — bytes by blob_id', () => {
    function toolsWith(email: Partial<EmailService>): EmailOpsTools {
      const m = { resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1') } as any;
      return new EmailOpsTools(
        m,
        email as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    }

    it('returns base64 bytes + provider-carried name/mime (Graph lane)', async () => {
      const email: Partial<EmailService> = {
        downloadAttachment: jest.fn().mockResolvedValue({
          data: Buffer.from('PK\x03\x04zip'),
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          filename: 'report.docx',
        }),
      };
      const t = toolsWith(email);
      const res: any = await t.getAttachment({} as any, {
        workspace_id: 'ws-1',
        mailbox_id: 'mb-1',
        blob_id: 'msg-1::att-1',
      });
      expect(res.name).toBe('report.docx');
      expect(res.mime_type).toContain('wordprocessingml');
      expect(res.size).toBe(Buffer.from('PK\x03\x04zip').length);
      expect(Buffer.from(res.content_base64, 'base64').toString()).toBe('PK\x03\x04zip');
      expect(email.downloadAttachment).toHaveBeenCalledWith('ws-1', '', 'mb-1', 'msg-1::att-1');
    });

    it('backfills name/mime from thread metadata when the byte-fetch lacks them (Gmail lane)', async () => {
      const email: Partial<EmailService> = {
        downloadAttachment: jest.fn().mockResolvedValue({
          data: Buffer.from('bytes'),
          contentType: null,
          filename: null,
        }),
        listThreadMessages: jest.fn().mockResolvedValue([
          {
            id: 'm1',
            attachments: [
              { blob_id: 'msg-1::att-1', name: 'invoice.pdf', type: 'application/pdf', size: 5, cid: null },
            ],
          },
        ]),
      };
      const t = toolsWith(email);
      const res: any = await t.getAttachment({} as any, {
        workspace_id: 'ws-1',
        mailbox_id: 'mb-1',
        blob_id: 'msg-1::att-1',
        thread_id: 'thread-1',
      });
      expect(res.name).toBe('invoice.pdf');
      expect(res.mime_type).toBe('application/pdf');
      expect(email.listThreadMessages).toHaveBeenCalledWith('ws-1', '', 'thread-1', 'mb-1');
    });

    it('backfills by unique size within the message when Gmail rotated the attachment id', async () => {
      // Gmail attachment ids are NOT stable across fetches: the fresh thread
      // read returns a DIFFERENT composite blob_id, so exact-id match fails.
      const email: Partial<EmailService> = {
        downloadAttachment: jest.fn().mockResolvedValue({
          data: Buffer.from('x'.repeat(13671)),
          contentType: null,
          filename: null,
        }),
        listThreadMessages: jest.fn().mockResolvedValue([
          {
            id: 'msg-1',
            attachments: [
              { blob_id: 'msg-1::ROTATED-A', name: 'analysis.docx', type: 'application/msword-x', size: 13671, cid: null },
              { blob_id: 'msg-1::ROTATED-B', name: 'other.docx', type: 'application/msword-x', size: 19256, cid: null },
            ],
          },
        ]),
      };
      const t = toolsWith(email);
      const res: any = await t.getAttachment({} as any, {
        workspace_id: 'ws-1',
        mailbox_id: 'mb-1',
        blob_id: 'msg-1::ORIGINAL-ID',
        thread_id: 'thread-1',
      });
      expect(res.name).toBe('analysis.docx');
      expect(res.mime_type).toBe('application/msword-x');
    });

    it('over the size cap: returns { error, size, max_bytes } and NO bytes (never truncates)', async () => {
      const big = Buffer.alloc(MCP_ATTACHMENT_MAX_BYTES + 1);
      const email: Partial<EmailService> = {
        downloadAttachment: jest.fn().mockResolvedValue({ data: big, contentType: 'video/mp4', filename: 'big.mp4' }),
      };
      const t = toolsWith(email);
      const res: any = await t.getAttachment({} as any, {
        workspace_id: 'ws-1',
        mailbox_id: 'mb-1',
        blob_id: 'msg-1::att-2',
      });
      expect(res.content_base64).toBeUndefined();
      expect(res.size).toBe(MCP_ATTACHMENT_MAX_BYTES + 1);
      expect(res.max_bytes).toBe(MCP_ATTACHMENT_MAX_BYTES);
      expect(String(res.error)).toContain(String(MCP_ATTACHMENT_MAX_BYTES + 1));
    });

    it('unknown blob / unreachable mailbox → NotFoundException (the service degrades to null)', async () => {
      const email: Partial<EmailService> = {
        downloadAttachment: jest.fn().mockResolvedValue(null),
      };
      const t = toolsWith(email);
      await expect(
        t.getAttachment({} as any, { workspace_id: 'ws-1', mailbox_id: 'mb-x', blob_id: 'nope' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('composeEmail — recipient mapping', () => {
    const origMode = process.env.UC_ENTITLEMENT_MODE;
    beforeEach(() => {
      process.env.UC_ENTITLEMENT_MODE = 'open';
    });
    afterEach(() => {
      if (origMode === undefined) delete process.env.UC_ENTITLEMENT_MODE;
      else process.env.UC_ENTITLEMENT_MODE = origMode;
    });

    function toolsWith(email: Partial<EmailService>): EmailOpsTools {
      const m = { resolveAndAuthorize: jest.fn().mockResolvedValue('ws-1') } as any;
      return new EmailOpsTools(
        m,
        email as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
    }

    const user = { __entitlements: ['email-ops'] } as any;
    const base = {
      workspace_id: 'ws-1',
      subject: 'Hi',
      body: 'Body',
      mode: 'draft' as const,
      external_source: 'email-ops-mcp',
      external_ref: 'ref-1',
    };

    it('forwards to_addresses + cc + bcc + reply_all + in_reply_to_thread_id', async () => {
      const composeEmail = jest.fn().mockResolvedValue({ id: 'm1', mode: 'draft' });
      const t = toolsWith({ composeEmail } as any);
      await t.composeEmail(user, {
        ...base,
        to_address: 'a@acme.test',
        to_addresses: ['a@acme.test', 'b@acme.test'],
        cc: ['c@acme.test'],
        bcc: ['d@acme.test'],
        reply_all: true,
        in_reply_to_thread_id: 'thread-ms-1',
        from_address: 'aaron@magicunicorn.tech',
      });
      expect(composeEmail).toHaveBeenCalledWith(
        'ws-1',
        expect.anything(),
        expect.objectContaining({
          toAddress: 'a@acme.test',
          toAddresses: ['a@acme.test', 'b@acme.test'],
          cc: ['c@acme.test'],
          bcc: ['d@acme.test'],
          replyAll: true,
          inReplyToThreadId: 'thread-ms-1',
          fromAddress: 'aaron@magicunicorn.tech',
          mode: 'draft',
        }),
      );
    });

    it('uses the first to_addresses entry as toAddress when to_address is omitted', async () => {
      const composeEmail = jest.fn().mockResolvedValue({ id: 'm1' });
      const t = toolsWith({ composeEmail } as any);
      await t.composeEmail(user, {
        ...base,
        to_addresses: ['a@acme.test', 'b@acme.test'],
      });
      expect(composeEmail).toHaveBeenCalledWith(
        'ws-1',
        expect.anything(),
        expect.objectContaining({
          toAddress: 'a@acme.test',
          toAddresses: ['a@acme.test', 'b@acme.test'],
          replyAll: false,
        }),
      );
    });

    it('forwards direct attachments, deferred send_at, and kit_id', async () => {
      const composeEmail = jest.fn().mockResolvedValue({ id: 'm1' });
      const t = toolsWith({ composeEmail } as any);
      const sendAt = new Date(Date.now() + 10 * 60_000).toISOString();
      await t.composeEmail(user, {
        ...base,
        to_address: 'a@acme.test',
        send_at: sendAt,
        kit_id: 'kit-1',
        attachments: [{ filename: 'brief.txt', content_type: 'text/plain', content_base64: 'SGk=' }],
      });
      expect(composeEmail).toHaveBeenCalledWith(
        'ws-1',
        expect.anything(),
        expect.objectContaining({
          sendAt: new Date(sendAt),
          kitId: 'kit-1',
          attachments: [expect.objectContaining({ filename: 'brief.txt', content_base64: 'SGk=' })],
        }),
      );
    });
  });
});
