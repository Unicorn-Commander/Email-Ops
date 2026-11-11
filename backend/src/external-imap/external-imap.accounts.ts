import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { MailboxAccount, User } from '@prisma/client';
import { encrypt, decrypt, isEncryptionConfigured } from '../connected-accounts/crypto';
import {
  SmtpConnection,
  SmtpSettings,
  requireExternalImapSend,
  externalImapSendEnabled,
} from './smtp-connection';
import { PrismaService } from '../prisma/prisma.service';
import { ImapConnection, ImapCredentials, requireExternalImap } from './imap-connection';

@Injectable()
export class ExternalImapAccounts {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: ImapConnection,
    private readonly smtp: SmtpConnection = new SmtpConnection(),
  ) {}

  async connect(
    workspaceId: string,
    user: User,
    input: ImapCredentials & { email_address: string; smtp?: SmtpSettings },
  ) {
    requireExternalImap(workspaceId);
    if (!isEncryptionConfigured())
      throw new ServiceUnavailableException('Mailbox encryption is not configured.');
    const result = await this.test(workspaceId, input);
    if (result.status !== 'ok') return result;
    const ownerKey = user.keycloakId ?? user.id;
    const emailAddress = input.email_address.toLowerCase();
    const encryptedPassword = encrypt({ password: input.password });
    const smtpData = input.smtp
      ? {
          smtpHost: input.smtp.host.toLowerCase(),
          smtpPort: input.smtp.port,
          smtpUsername: input.smtp.username ?? null,
          smtpEncryptedPassword: input.smtp.password
            ? encrypt({ password: input.smtp.password })
            : null,
        }
      : {};
    try {
      return await this.prisma.withWorkspace(workspaceId, ownerKey, async (tx) => {
        const existing = await tx.mailboxAccount.findUnique({
          where: { workspaceId_emailAddress: { workspaceId, emailAddress } },
        });
        // Never take over another owner's mailbox or change an existing send lane.
        if (
          existing &&
          (existing.ownerKind !== 'HUMAN' ||
            existing.ownerKey !== ownerKey ||
            existing.provider !== 'external_imap')
        ) {
          throw new ConflictException('This address is already registered.');
        }
        const mailbox =
          existing ??
          (await tx.mailboxAccount.create({
            data: {
              workspaceId,
              emailAddress,
              ownerKind: 'HUMAN',
              ownerKey,
              provider: 'external_imap',
              kind: 'external_imap',
              isDefault: false,
              postmarkLane: false,
            },
          }));
        await tx.externalImapAccount.upsert({
          where: { mailboxId: mailbox.id },
          create: {
            mailboxId: mailbox.id,
            host: input.host.toLowerCase(),
            port: 993,
            username: input.username,
            encryptedPassword,
            ...smtpData,
          },
          update: {
            host: input.host.toLowerCase(),
            port: 993,
            username: input.username,
            encryptedPassword,
            ...smtpData,
          },
        });
        // Explicit allowlist: even ciphertext and username stay out of the API.
        return { status: 'ok' as const, mailbox_id: mailbox.id };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('Could not save the mailbox connection.');
    }
  }

  async test(workspaceId: string, input: ImapCredentials & { smtp?: SmtpSettings }) {
    requireExternalImap(workspaceId);
    if (input.smtp) requireExternalImapSend(workspaceId);
    const result = await this.connection.test(workspaceId, input);
    if (result.status !== 'ok' || !input.smtp) return result;
    return this.smtp.test(workspaceId, {
      ...input.smtp,
      username: input.smtp.username ?? input.username,
      password: input.smtp.password ?? input.password,
    });
  }

  async credentials(
    mailbox: MailboxAccount,
  ): Promise<ImapCredentials & { smtp?: import('./smtp-connection').SmtpCredentials }> {
    requireExternalImap(mailbox.workspaceId);
    if (
      mailbox.provider !== 'external_imap' ||
      mailbox.ownerKind !== 'HUMAN' ||
      !mailbox.ownerKey ||
      !mailbox.active
    ) {
      throw new Error('Mailbox unavailable');
    }
    const row = await this.prisma.withWorkspace(mailbox.workspaceId, mailbox.ownerKey, (tx) =>
      tx.externalImapAccount.findFirst({
        where: {
          mailboxId: mailbox.id,
          mailbox: {
            workspaceId: mailbox.workspaceId,
            ownerKind: 'HUMAN',
            ownerKey: mailbox.ownerKey,
            provider: 'external_imap',
            active: true,
          },
        },
      }),
    );
    if (!row) throw new Error('Mailbox unavailable');
    return {
      host: row.host,
      port: row.port,
      username: row.username,
      security: 'tls',
      password: decrypt<{ password: string }>(row.encryptedPassword).password,
      ...(externalImapSendEnabled(mailbox.workspaceId) && row.smtpHost && row.smtpPort
        ? {
            smtp: {
              host: row.smtpHost,
              port: row.smtpPort as 465 | 587,
              username: row.smtpUsername ?? row.username,
              password: decrypt<{ password: string }>(
                row.smtpEncryptedPassword ?? row.encryptedPassword,
              ).password,
            },
          }
        : {}),
    };
  }
}
