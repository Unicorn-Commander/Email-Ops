import { ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExternalImapAccounts } from './external-imap.accounts';
import { ExternalImapController } from './external-imap.controller';
import { ImapConnection } from './imap-connection';

describe('external IMAP disconnect', () => {
  const previousEnabled = process.env.EXTERNAL_IMAP_ENABLED;
  const previousAllowlist = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
  const owner = { id: 'user-owner', keycloakId: 'owner-sub' } as User;
  const otherMember = { id: 'user-other', keycloakId: 'other-sub' } as User;

  let mailbox: {
    id: string;
    workspaceId: string;
    provider: string;
    ownerKind: string;
    ownerKey: string;
    active: boolean;
  };
  let credentialRow: { encryptedPassword: string } | null;
  let tx: any;
  let accounts: ExternalImapAccounts;
  let controller: ExternalImapController;

  beforeEach(() => {
    process.env.EXTERNAL_IMAP_ENABLED = 'true';
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-one';
    mailbox = {
      id: 'mailbox-one',
      workspaceId: 'workspace-one',
      provider: 'external_imap',
      ownerKind: 'HUMAN',
      ownerKey: 'owner-sub',
      active: true,
    };
    credentialRow = { encryptedPassword: 'ciphertext-only-fixture' };
    tx = {
      mailboxAccount: {
        findFirst: jest.fn().mockResolvedValue(mailbox),
        update: jest.fn().mockImplementation(async ({ data }: { data: { active: boolean } }) => {
          mailbox.active = data.active;
          return mailbox;
        }),
      },
      externalImapAccount: {
        deleteMany: jest.fn().mockImplementation(async () => {
          const count = credentialRow ? 1 : 0;
          credentialRow = null;
          return { count };
        }),
      },
    };
    const prisma = {
      withWorkspace: jest.fn(async (_workspace: string, _owner: string, fn: (db: any) => unknown) =>
        fn(tx),
      ),
    };
    accounts = new ExternalImapAccounts(prisma as unknown as PrismaService, {} as ImapConnection);
    controller = new ExternalImapController(accounts, {} as ImapConnection);
  });

  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = previousEnabled;
    if (previousAllowlist === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = previousAllowlist;
    jest.restoreAllMocks();
  });

  it('owner wipes the credential row and marks the mailbox inactive', async () => {
    const restore = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await expect(controller.disconnect('workspace-one', owner, 'mailbox-one')).resolves.toEqual({
        mailbox_id: 'mailbox-one',
        status: 'disconnected',
        credential: 'wiped',
      });
      expect(credentialRow).toBeNull();
      expect(mailbox.active).toBe(false);
      expect(tx.externalImapAccount.deleteMany).toHaveBeenCalledWith({
        where: { mailboxId: 'mailbox-one' },
      });
    } finally {
      restore.mockRestore();
    }
  });

  it('another workspace member cannot disconnect the owner mailbox', async () => {
    await expect(
      accounts.disconnect('workspace-one', otherMember, 'mailbox-one'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(credentialRow).not.toBeNull();
    expect(mailbox.active).toBe(true);
    expect(tx.externalImapAccount.deleteMany).not.toHaveBeenCalled();
  });

  it('is idempotent after the credential row is already gone', async () => {
    credentialRow = null;
    mailbox.active = false;
    await expect(accounts.disconnect('workspace-one', owner, 'mailbox-one')).resolves.toEqual({
      mailbox_id: 'mailbox-one',
      status: 'disconnected',
      credential: 'already_absent',
    });
    expect(credentialRow).toBeNull();
    expect(mailbox.active).toBe(false);
  });

  it('keeps the allowlist gate on disconnect', async () => {
    process.env.EXTERNAL_IMAP_WORKSPACE_IDS = 'workspace-two';
    await expect(accounts.disconnect('workspace-one', owner, 'mailbox-one')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(credentialRow).not.toBeNull();
    expect(tx.externalImapAccount.deleteMany).not.toHaveBeenCalled();
  });
});
