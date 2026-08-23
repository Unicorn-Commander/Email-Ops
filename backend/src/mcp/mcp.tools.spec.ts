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
});
