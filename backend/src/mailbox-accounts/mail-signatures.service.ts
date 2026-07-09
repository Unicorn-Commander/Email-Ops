import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { assertMayActThroughMailbox } from '../common/mailbox/mailbox-fence';

export interface MailSignatureView {
  id: string;
  mailbox_account_id: string;
  name: string;
  html: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface SaveMailSignatureInput {
  name: string;
  html: string;
  isDefault?: boolean;
}

@Injectable()
export class MailSignaturesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string, ucUid: string, mailboxId: string): Promise<MailSignatureView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, mailboxId, ucUid);
      const rows = await tx.mailSignature.findMany({
        where: { workspaceId, mailboxAccountId: mailboxId },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      });
      return rows.map(toView);
    });
  }

  async create(
    workspaceId: string,
    ucUid: string,
    mailboxId: string,
    input: SaveMailSignatureInput,
  ): Promise<MailSignatureView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, mailboxId, ucUid);
      if (input.isDefault) {
        await tx.mailSignature.updateMany({
          where: { workspaceId, mailboxAccountId: mailboxId, isDefault: true },
          data: { isDefault: false },
        });
      }
      const row = await tx.mailSignature.create({
        data: {
          workspaceId,
          mailboxAccountId: mailboxId,
          name: input.name,
          html: input.html,
          isDefault: input.isDefault ?? false,
        },
      });
      return toView(row);
    });
  }

  async update(
    workspaceId: string,
    ucUid: string,
    mailboxId: string,
    signatureId: string,
    input: Partial<SaveMailSignatureInput>,
  ): Promise<MailSignatureView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, mailboxId, ucUid);
      await this.assertSignature(tx, workspaceId, mailboxId, signatureId);
      if (input.isDefault) {
        await tx.mailSignature.updateMany({
          where: { workspaceId, mailboxAccountId: mailboxId, isDefault: true, NOT: { id: signatureId } },
          data: { isDefault: false },
        });
      }
      const row = await tx.mailSignature.update({
        where: { id: signatureId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.html !== undefined ? { html: input.html } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        },
      });
      return toView(row);
    });
  }

  async setDefault(
    workspaceId: string,
    ucUid: string,
    mailboxId: string,
    signatureId: string,
  ): Promise<MailSignatureView> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, mailboxId, ucUid);
      await this.assertSignature(tx, workspaceId, mailboxId, signatureId);
      await tx.mailSignature.updateMany({
        where: { workspaceId, mailboxAccountId: mailboxId, isDefault: true },
        data: { isDefault: false },
      });
      const row = await tx.mailSignature.update({
        where: { id: signatureId },
        data: { isDefault: true },
      });
      return toView(row);
    });
  }

  async delete(workspaceId: string, ucUid: string, mailboxId: string, signatureId: string) {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await this.assertMailbox(tx, workspaceId, mailboxId, ucUid);
      await this.assertSignature(tx, workspaceId, mailboxId, signatureId);
      await tx.mailSignature.delete({ where: { id: signatureId } });
      return { removed: true };
    });
  }

  private async assertMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxId: string,
    ucUid: string | null,
  ) {
    const mailbox = await tx.mailboxAccount.findFirst({
      where: { id: mailboxId, workspaceId },
      select: { id: true, ownerKind: true, ownerKey: true },
    });
    if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
    assertMayActThroughMailbox(mailbox, ucUid);
  }

  private async assertSignature(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxId: string,
    signatureId: string,
  ) {
    const signature = await tx.mailSignature.findFirst({
      where: { id: signatureId, workspaceId, mailboxAccountId: mailboxId },
      select: { id: true },
    });
    if (!signature) throw new NotFoundException('Signature not found in this mailbox.');
  }
}

function toView(row: {
  id: string;
  mailboxAccountId: string;
  name: string;
  html: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}): MailSignatureView {
  return {
    id: row.id,
    mailbox_account_id: row.mailboxAccountId,
    name: row.name,
    html: row.html,
    is_default: row.isDefault,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
