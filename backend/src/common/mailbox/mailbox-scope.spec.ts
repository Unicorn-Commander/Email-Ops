import { MailboxScope, MembershipStatus, WorkspaceRole } from '@prisma/client';
import { resolveMailboxScope, visibleMailboxIds } from './mailbox-scope';

describe('mailbox scope resolver', () => {
  const workspaceId = 'workspace-1';
  const human = { id: 'human-mailbox', ownerKind: 'HUMAN', ownerKey: 'member-1' };
  const otherHuman = { id: 'other-human', ownerKind: 'HUMAN', ownerKey: 'member-2' };
  const agent = { id: 'agent-mailbox', ownerKind: 'AGENT', ownerKey: 'agent-1' };
  const shared = { id: 'shared-mailbox', ownerKind: 'SHARED', ownerKey: null };
  const mailboxes = [human, otherHuman, agent, shared];

  function db(membership: unknown) {
    return {
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      membership: { findUnique: jest.fn().mockResolvedValue(membership) },
      mailboxAccount: {
        findMany: jest.fn(async (args: { where?: { ownerKind?: string; ownerKey?: { in: string[] } } }) => {
          if (args.where?.ownerKind === 'HUMAN') {
            return mailboxes.filter(
              (mailbox) =>
                mailbox.ownerKind === 'HUMAN' &&
                args.where?.ownerKey?.in?.includes(mailbox.ownerKey ?? ''),
            );
          }
          return mailboxes;
        }),
      },
    } as any;
  }

  it('leaves ALL members workspace-wide, including shared and agent mailboxes', async () => {
    const database = db({
      role: WorkspaceRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      mailboxScope: MailboxScope.ALL,
    });

    await expect(visibleMailboxIds(database, workspaceId, 'member-1')).resolves.toEqual(
      mailboxes.map((mailbox) => mailbox.id),
    );
  });

  it('limits OWNED members to their HUMAN ownerKey and omits agent/shared mailboxes', async () => {
    const database = db({
      role: WorkspaceRole.MEMBER,
      status: MembershipStatus.ACTIVE,
      mailboxScope: MailboxScope.OWNED,
    });

    await expect(visibleMailboxIds(database, workspaceId, 'member-1')).resolves.toEqual([human.id]);
    await expect(resolveMailboxScope(database, workspaceId, 'member-1')).resolves.toMatchObject({
      governed: true,
      ids: [human.id],
    });
  });

  it('keeps ADMIN and OWNER workspace-wide even if their stored scope is OWNED', async () => {
    for (const role of [WorkspaceRole.ADMIN, WorkspaceRole.OWNER]) {
      const database = db({
        role,
        status: MembershipStatus.ACTIVE,
        mailboxScope: MailboxScope.OWNED,
      });
      await expect(visibleMailboxIds(database, workspaceId, 'member-1')).resolves.toEqual(
        mailboxes.map((mailbox) => mailbox.id),
      );
    }
  });

  it('fails closed for a suspended membership', async () => {
    const database = db({
      role: WorkspaceRole.MEMBER,
      status: MembershipStatus.SUSPENDED,
      mailboxScope: MailboxScope.ALL,
    });
    await expect(resolveMailboxScope(database, workspaceId, 'member-1')).resolves.toEqual({
      governed: true,
      ids: [],
    });
  });
});
