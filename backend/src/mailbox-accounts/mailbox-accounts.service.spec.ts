import { MailboxAccount, MailboxOwnerKind, MailboxProvisionState } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailEngineAdminPort } from '../mail-engine-admin/mail-engine-admin.port';
import { DeviceConfigService } from './device-config.service';
import { MailboxAccountsService } from './mailbox-accounts.service';

describe('MailboxAccountsService (workspace default mailbox)', () => {
  const WS = '0190a000-7e57-7000-8000-00000000c001';

  function row(overrides: Partial<MailboxAccount> = {}): MailboxAccount {
    return {
      id: 'mb-1',
      workspaceId: WS,
      emailAddress: 'primary@example.com',
      displayName: null,
      ownerKind: MailboxOwnerKind.SHARED,
      ownerKey: null,
      kind: 'shared',
      provider: 'stalwart',
      provisionState: MailboxProvisionState.PROVISIONED,
      isDefault: false,
      postmarkLane: false,
      active: true,
      createdAt: new Date('2026-11-06T00:00:00Z'),
      updatedAt: new Date('2026-11-06T00:00:00Z'),
      ...overrides,
    } as MailboxAccount;
  }

  function make(options: {
    existing?: MailboxAccount | null;
    workspaceDefault?: MailboxAccount | null;
    replacement?: MailboxAccount | null;
  } = {}) {
    const existing = options.existing === undefined ? row() : options.existing;
    const workspaceDefault = options.workspaceDefault ?? null;
    const replacement = options.replacement ?? null;
    const tx = {
      mailboxAccount: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id && typeof where.id === 'object') return replacement;
          if (where.id) return existing;
          if (where.isDefault) return workspaceDefault;
          return null;
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
          row({ ...data, id: 'mb-created' } as Partial<MailboxAccount>),
        ),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          row({
            ...(where.id === existing?.id ? existing : replacement),
            ...data,
          } as Partial<MailboxAccount>),
        ),
      },
      agentMailbox: { count: jest.fn().mockResolvedValue(0) },
      agentActionEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      withWorkspace: jest.fn((_ws: string, _uid: string | null, fn: (t: unknown) => unknown) => fn(tx)),
    };
    const admin = { isConfigured: () => false };
    const service = new MailboxAccountsService(
      prisma as unknown as PrismaService,
      admin as unknown as MailEngineAdminPort,
      {} as DeviceConfigService,
    );
    return { service, tx };
  }

  it('makes the first mailbox the default even when no existing default exists', async () => {
    const { service, tx } = make({ existing: null, workspaceDefault: null });

    await service.createMailbox(WS, 'user-1', {
      emailAddress: 'first@example.com',
      isDefault: false,
    });

    expect(tx.mailboxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ emailAddress: 'first@example.com', isDefault: true }),
    });
  });

  it('without is_default, the first mailbox is the default and a second one is not', async () => {
    const first = make({ workspaceDefault: null });
    await first.service.createMailbox(WS, 'user-1', { emailAddress: 'first@example.com' });
    expect(first.tx.mailboxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ emailAddress: 'first@example.com', isDefault: true }),
    });

    const held = row({ id: 'mb-first', emailAddress: 'first@example.com', isDefault: true });
    const second = make({ workspaceDefault: held });
    await second.service.createMailbox(WS, 'user-1', { emailAddress: 'second@example.com' });
    expect(second.tx.mailboxAccount.updateMany).not.toHaveBeenCalled();
    expect(second.tx.mailboxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ emailAddress: 'second@example.com', isDefault: false }),
    });
  });

  it('setting a new mailbox default clears the prior holder before create', async () => {
    const oldDefault = row({ id: 'mb-old', isDefault: true });
    const { service, tx } = make({ existing: null, workspaceDefault: oldDefault });

    await service.createMailbox(WS, 'user-1', {
      emailAddress: 'new@example.com',
      isDefault: true,
    });

    expect(tx.mailboxAccount.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, isDefault: true },
      data: { isDefault: false },
    });
    expect(tx.mailboxAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isDefault: true }),
    });
  });

  it('PATCH is_default=true demotes every other default in the workspace', async () => {
    const current = row({ id: 'mb-current', isDefault: false });
    const { service, tx } = make({ existing: current });

    const output = await service.updateMailbox(WS, 'user-1', 'mb-current', { isDefault: true });

    expect(tx.mailboxAccount.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, isDefault: true },
      data: { isDefault: false },
    });
    expect(tx.mailboxAccount.update).toHaveBeenCalledWith({
      where: { id: 'mb-current' },
      data: { isDefault: true },
    });
    expect(output?.is_default).toBe(true);
  });

  it('parking the default promotes another active mailbox', async () => {
    const current = row({ id: 'mb-current', isDefault: true });
    const replacement = row({ id: 'mb-next', emailAddress: 'next@example.com', isDefault: false });
    const { service, tx } = make({ existing: current, replacement });

    await service.updateMailbox(WS, 'user-1', 'mb-current', { active: false });

    expect(tx.mailboxAccount.update).toHaveBeenCalledWith({
      where: { id: 'mb-next' },
      data: { isDefault: true },
    });
    expect(tx.mailboxAccount.update).toHaveBeenCalledWith({
      where: { id: 'mb-current' },
      data: { active: false, isDefault: false },
    });
  });
});
