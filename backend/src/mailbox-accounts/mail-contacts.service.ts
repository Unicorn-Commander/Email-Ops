import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertMayActThroughMailbox } from '../common/mailbox/mailbox-fence';

export interface MailContactView {
  id: string;
  mailbox_account_id: string;
  email: string;
  display_name: string | null;
  last_seen_at: string;
  frequency: number;
}

@Injectable()
export class MailContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async search(
    workspaceId: string,
    ucUid: string,
    mailboxId: string,
    query: string | null,
  ): Promise<MailContactView[]> {
    const q = (query ?? '').trim().toLowerCase();
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await tx.mailboxAccount.findFirst({
        where: { id: mailboxId, workspaceId },
        select: { id: true, ownerKind: true, ownerKey: true },
      });
      if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
      assertMayActThroughMailbox(mailbox, ucUid);
      const rows = await tx.mailContact.findMany({
        where: {
          workspaceId,
          mailboxAccountId: mailboxId,
          ...(q
            ? {
                OR: [
                  { email: { startsWith: q, mode: 'insensitive' } },
                  { displayName: { startsWith: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [{ frequency: 'desc' }, { lastSeenAt: 'desc' }],
        take: 12,
      });
      return rows.map((row) => ({
        id: row.id,
        mailbox_account_id: row.mailboxAccountId,
        email: row.email,
        display_name: row.displayName,
        last_seen_at: row.lastSeenAt.toISOString(),
        frequency: row.frequency,
      }));
    });
  }
}
