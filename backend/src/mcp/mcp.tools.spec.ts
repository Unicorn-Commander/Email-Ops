import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { EmailOpsTools, MCP_ATTACHMENT_MAX_BYTES } from './mcp.tools';
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
});
