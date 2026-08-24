import { ForbiddenException } from '@nestjs/common';
import { WorkspaceRole } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { EmailOpsTools } from './mcp.tools';
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
});
