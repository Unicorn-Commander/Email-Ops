import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { assertMayActThroughMailbox } from '../common/mailbox/mailbox-fence';
import { StalwartPort } from '../stalwart/stalwart.port';

export interface MailVacationSettingsView {
  id: string;
  mailbox_account_id: string;
  enabled: boolean;
  subject: string;
  body_html: string;
  body_text: string;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveMailVacationInput {
  enabled: boolean;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  startsAt: Date | null;
  endsAt: Date | null;
}

@Injectable()
export class MailVacationService {
  private readonly logger = new Logger(MailVacationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
  ) {}

  async get(workspaceId: string, ucUid: string, mailboxId: string): Promise<MailVacationSettingsView | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await this.assertMailbox(tx, workspaceId, mailboxId, ucUid);
      if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
      const row = await tx.mailVacationSetting.findFirst({
        where: { workspaceId, mailboxAccountId: mailboxId },
      });
      return row ? toView(row) : null;
    });
  }

  async upsert(
    workspaceId: string,
    ucUid: string,
    mailboxId: string,
    input: SaveMailVacationInput,
  ): Promise<MailVacationSettingsView> {
    const result = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await this.assertMailbox(tx, workspaceId, mailboxId, ucUid);
      if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
      const row = await tx.mailVacationSetting.upsert({
        where: {
          workspaceId_mailboxAccountId: {
            workspaceId,
            mailboxAccountId: mailboxId,
          },
        },
        create: {
          workspaceId,
          mailboxAccountId: mailboxId,
          enabled: input.enabled,
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          bodyText: input.bodyText,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        },
        update: {
          enabled: input.enabled,
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          bodyText: input.bodyText,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        },
      });
      return { mailbox: mailbox.emailAddress, row: toView(row) };
    });
    await this.syncEngine(result.mailbox, input);
    return result.row;
  }

  private async syncEngine(mailbox: string, input: SaveMailVacationInput): Promise<void> {
    try {
      const ok = await this.stalwart.setVacation(mailbox, {
        isEnabled: input.enabled,
        subject: input.subject,
        textBody: input.bodyText,
        htmlBody: input.bodyHtml,
        fromDate: input.startsAt ? input.startsAt.toISOString() : null,
        toDate: input.endsAt ? input.endsAt.toISOString() : null,
      });
      if (!ok) {
        this.logger.warn(`VacationResponse unsupported or unavailable for ${mailbox} — persisted locally only.`);
      }
    } catch (err) {
      this.logger.warn(
        `VacationResponse sync for ${mailbox} failed: ${(err as Error).message} — persisted locally only.`,
      );
    }
  }

  private async assertMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxId: string,
    ucUid: string | null,
  ) {
    const mailbox = await tx.mailboxAccount.findFirst({
      where: { id: mailboxId, workspaceId },
      select: { emailAddress: true, ownerKind: true, ownerKey: true },
    });
    if (mailbox) assertMayActThroughMailbox(mailbox, ucUid);
    return mailbox;
  }
}

function toView(row: {
  id: string;
  mailboxAccountId: string;
  enabled: boolean;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  startsAt: Date | null;
  endsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): MailVacationSettingsView {
  return {
    id: row.id,
    mailbox_account_id: row.mailboxAccountId,
    enabled: row.enabled,
    subject: row.subject,
    body_html: row.bodyHtml,
    body_text: row.bodyText,
    starts_at: row.startsAt ? row.startsAt.toISOString() : null,
    ends_at: row.endsAt ? row.endsAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
