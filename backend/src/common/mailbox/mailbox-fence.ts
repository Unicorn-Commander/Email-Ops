import { ForbiddenException } from '@nestjs/common';
import { MailboxOwnerKind } from '@prisma/client';

/**
 * Per-user fence for mailbox-scoped settings, mirroring
 * EmailService.mayActThroughMailbox: a HUMAN mailbox is PRIVATE to its owner;
 * SHARED / AGENT mailboxes are workspace resources any member may configure.
 * Call AFTER confirming the mailbox exists in the caller's workspace.
 */
export function assertMayActThroughMailbox(
  mb: { ownerKind: MailboxOwnerKind; ownerKey: string | null },
  ucUid: string | null,
): void {
  if (mb.ownerKind === MailboxOwnerKind.HUMAN && (!ucUid || mb.ownerKey !== ucUid)) {
    throw new ForbiddenException('This mailbox is private to its owner.');
  }
}
