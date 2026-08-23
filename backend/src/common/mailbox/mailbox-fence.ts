import { ForbiddenException } from '@nestjs/common';
import { MailboxOwnerKind } from '@prisma/client';

/**
 * Canonical per-user mailbox fence.
 *
 * A HUMAN mailbox is PRIVATE to its owner; SHARED / AGENT mailboxes are
 * workspace resources any member may configure.
 *
 * Identity fallback: `ownerKey` is canonically the keycloakId, but `ucUid` can
 * arrive as the local User.id (auth-path dependent). We resolve the caller via
 * `user.findFirst` and accept a match on either identity.
 */
export async function mayActThroughMailbox(
  db: { user: { findFirst: (args: any) => Promise<{ id: string; keycloakId: string | null } | null> } },
  mb: { ownerKind: string; ownerKey: string | null },
  ucUid: string | null,
): Promise<boolean> {
  if (mb.ownerKind !== MailboxOwnerKind.HUMAN) return true;
  if (!mb.ownerKey || !ucUid) return false;
  if (mb.ownerKey === ucUid) return true;

  const u = await db.user.findFirst({
    where: { OR: [{ keycloakId: ucUid }, { id: ucUid }] },
  });
  return !!u && (mb.ownerKey === u.keycloakId || mb.ownerKey === u.id);
}

/**
 * Async version of the fence that throws ForbiddenException on failure.
 */
export async function assertMayActThroughMailbox(
  db: { user: { findFirst: (args: any) => Promise<{ id: string; keycloakId: string | null } | null> } },
  mb: { ownerKind: string; ownerKey: string | null },
  ucUid: string | null,
): Promise<void> {
  if (!(await mayActThroughMailbox(db, mb, ucUid))) {
    throw new ForbiddenException('This mailbox is private to its owner.');
  }
}
