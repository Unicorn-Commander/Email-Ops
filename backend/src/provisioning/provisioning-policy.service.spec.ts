import { ForbiddenException } from '@nestjs/common';
import { ProvisioningMode, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningPolicyService } from './provisioning-policy.service';

/**
 * ProvisioningPolicyService: the effective-policy resolution (DEFAULT when no row)
 * + the authorize() gate over the Balanced default, with a mocked tx.
 */
describe('ProvisioningPolicyService', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';
  const UID = 'uc-uid';

  function svc(policyRow: unknown = null) {
    const tx = {
      provisioningPolicy: {
        findUnique: jest.fn().mockResolvedValue(policyRow),
        upsert: jest.fn(),
      },
    };
    const prisma = {
      withWorkspace: jest.fn((_w: string, _u: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    return new ProvisioningPolicyService(prisma);
  }

  it('getEffectivePolicy returns the Balanced DEFAULT (is_default) when no row exists', async () => {
    const v = await svc(null).getView(WS, UID);
    expect(v.is_default).toBe(true);
    expect(v.human_mailbox_create_mode).toBe(ProvisioningMode.MANAGER);
    expect(v.agent_mailbox_create_mode).toBe(ProvisioningMode.ADMIN_ONLY);
    expect(v.approver_min_role).toBe(WorkspaceRole.ADMIN);
  });

  it('authorize(agent.create) — MANAGER allowed, MEMBER denied (403) under the default', async () => {
    await expect(svc().authorize(WS, UID, WorkspaceRole.MANAGER, 'agent.create')).resolves.toBe('allow');
    await expect(svc().authorize(WS, UID, WorkspaceRole.MEMBER, 'agent.create')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('authorize(agentMailbox.edit) — the send identity is ADMIN_ONLY (MANAGER denied)', async () => {
    await expect(svc().authorize(WS, UID, WorkspaceRole.ADMIN, 'agentMailbox.edit')).resolves.toBe('allow');
    await expect(
      svc().authorize(WS, UID, WorkspaceRole.MANAGER, 'agentMailbox.edit'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a workspace row overrides the default (human-mailbox create = OPEN → a MEMBER may)', async () => {
    const row = {
      humanMailboxCreateMode: ProvisioningMode.OPEN,
      humanMailboxEditMode: ProvisioningMode.MANAGER,
      agentMailboxCreateMode: ProvisioningMode.ADMIN_ONLY,
      agentMailboxEditMode: ProvisioningMode.ADMIN_ONLY,
      agentCreateMode: ProvisioningMode.MANAGER,
      agentEditMode: ProvisioningMode.MANAGER,
      approverMinRole: WorkspaceRole.ADMIN,
      allowSelfServiceOwnMailbox: false,
      maxMailboxesPerWorkspace: null,
      maxAgentsPerWorkspace: null,
    };
    const s = svc(row);
    expect((await s.getView(WS, UID)).is_default).toBe(false);
    await expect(s.authorize(WS, UID, WorkspaceRole.MEMBER, 'humanMailbox.create')).resolves.toBe('allow');
  });
});
