import { MailboxAccount, MailboxOwnerKind, MailboxProvisionState, User, WorkspaceRole } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { DeviceConfigService } from './device-config.service';
import { MailContactsService } from './mail-contacts.service';
import { MailSignaturesService } from './mail-signatures.service';
import { MailVacationService } from './mail-vacation.service';
import { MailboxAccountsController } from './mailbox-accounts.controller';
import { MailboxAccountsService } from './mailbox-accounts.service';

/**
 * POST /workspaces/:id/mailboxes is the REST provisioning route. is_default is
 * optional and is applied only by MailboxAccountsService.createMailbox.
 */
describe('MailboxAccountsController provisioning is_default', () => {
  const WS = '0190a000-7e57-7000-8000-00000000c001';

  function row(overrides: Partial<MailboxAccount> = {}): MailboxAccount {
    return {
      id: 'mb-1',
      workspaceId: WS,
      emailAddress: 'desk@example.com',
      displayName: null,
      ownerKind: MailboxOwnerKind.SHARED,
      ownerKey: null,
      kind: 'shared',
      provider: 'stalwart',
      provisionState: MailboxProvisionState.REGISTERED,
      isDefault: false,
      postmarkLane: false,
      active: true,
      createdAt: new Date('2026-11-06T00:00:00Z'),
      updatedAt: new Date('2026-11-06T00:00:00Z'),
      ...overrides,
    } as MailboxAccount;
  }

  function caller(): User {
    const u: WithWorkspaceClaim = {
      id: 'local-casey',
      email: 'casey.rivera@example.com',
      username: 'casey',
      firstName: 'Casey',
      lastName: 'Rivera',
      avatarUrl: null,
      keycloakId: 'kc-casey',
      passwordHash: null,
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date('2026-11-06T00:00:00Z'),
      updatedAt: new Date('2026-11-06T00:00:00Z'),
      __ucUid: 'kc-casey',
      __entitlements: ['email-ops:mailbox'],
      __workspaceClaim: WS,
    };
    return u as User;
  }

  function harness(workspaceDefault: MailboxAccount | null) {
    const tx = {
      mailboxAccount: {
        findFirst: jest.fn(async () => workspaceDefault),
        count: jest.fn().mockResolvedValue(workspaceDefault ? 1 : 0),
        updateMany: jest.fn().mockResolvedValue({ count: workspaceDefault ? 1 : 0 }),
        create: jest.fn(async ({ data }: { data: Partial<MailboxAccount> }) =>
          row({ ...data, id: 'mb-created' }),
        ),
      },
      agentMailbox: { count: jest.fn().mockResolvedValue(0) },
      agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const mailboxes = new MailboxAccountsService(
      prisma as unknown as PrismaService,
      { isConfigured: () => false } as unknown as MailEngineAdminPort,
      {} as DeviceConfigService,
    );
    const policy = {
      authorize: jest.fn().mockResolvedValue('allow'),
      getEffectivePolicy: jest.fn().mockResolvedValue({ maxMailboxesPerWorkspace: null }),
      fileRequest: jest.fn().mockResolvedValue({ id: 'req-1' }),
    };
    const controller = new MailboxAccountsController(
      mailboxes,
      policy as unknown as ProvisioningPolicyService,
      {} as MailProviderPort,
      {} as MailSignaturesService,
      {} as MailContactsService,
      {} as MailVacationService,
    );
    return { controller, tx, policy };
  }

  it('is_default true demotes the previous default before the new mailbox is created', async () => {
    const held = row({ id: 'mb-old', emailAddress: 'old@example.com', isDefault: true });
    const { controller, tx } = harness(held);

    const out = await controller.create(WS, caller(), WorkspaceRole.OWNER, {
      email_address: 'new@example.com',
      is_default: true,
    });

    expect(tx.mailboxAccount.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, isDefault: true },
      data: { isDefault: false },
    });
    expect(tx.mailboxAccount.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.mailboxAccount.create.mock.invocationCallOrder[0],
    );
    expect(tx.mailboxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ emailAddress: 'new@example.com', isDefault: true }),
    });
    expect(out).toMatchObject({ is_default: true, email_address: 'new@example.com' });
  });

  it('without is_default the first mailbox is the default and a second one is not', async () => {
    const first = harness(null);
    const created = await first.controller.create(WS, caller(), WorkspaceRole.OWNER, {
      email_address: 'first@example.com',
    });
    expect(first.tx.mailboxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ emailAddress: 'first@example.com', isDefault: true }),
    });
    expect(created).toMatchObject({ is_default: true });

    const held = row({ id: 'mb-first', emailAddress: 'first@example.com', isDefault: true });
    const second = harness(held);
    const later = await second.controller.create(WS, caller(), WorkspaceRole.OWNER, {
      email_address: 'second@example.com',
    });
    expect(second.tx.mailboxAccount.updateMany).not.toHaveBeenCalled();
    expect(second.tx.mailboxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ emailAddress: 'second@example.com', isDefault: false }),
    });
    expect(later).toMatchObject({ is_default: false });
  });

  it('files is_default on an approval request and does not create the mailbox yet', async () => {
    const createMailbox = jest.fn();
    const fileRequest = jest.fn().mockResolvedValue({ id: 'req-1' });
    const controller = new MailboxAccountsController(
      { assertValidAddress: jest.fn(), countHostedMailboxes: jest.fn().mockResolvedValue(0), createMailbox } as unknown as MailboxAccountsService,
      {
        authorize: jest.fn().mockResolvedValue('requires_approval'),
        fileRequest,
        getEffectivePolicy: jest.fn(),
      } as unknown as ProvisioningPolicyService,
      {} as MailProviderPort,
      {} as MailSignaturesService,
      {} as MailContactsService,
      {} as MailVacationService,
    );

    const out = await controller.create(WS, caller(), WorkspaceRole.MEMBER, {
      email_address: 'queued@example.com',
      is_default: true,
    });

    expect(createMailbox).not.toHaveBeenCalled();
    expect(fileRequest).toHaveBeenCalledWith(
      WS,
      'kc-casey',
      expect.objectContaining({
        action: 'create',
        payload: expect.objectContaining({ emailAddress: 'queued@example.com', isDefault: true }),
      }),
    );
    expect(out).toEqual({ provisioning_request: { id: 'req-1' } });
  });
});
