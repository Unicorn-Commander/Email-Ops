import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { MailboxAccount, User } from '@prisma/client';
import { encrypt, decrypt, isEncryptionConfigured } from '../connected-accounts/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ImapConnection, ImapCredentials, requireExternalImap } from './imap-connection';

@Injectable()
export class ExternalImapAccounts {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: ImapConnection,
  ) {}

  async connect(
    workspaceId: string,
    user: User,
    input: ImapCredentials & { email_address: string },
  ) {
    requireExternalImap();
    if (!isEncryptionConfigured())
      throw new ServiceUnavailableException('Mailbox encryption is not configured.');
    const result = await this.connection.test(input);
    if (result.status !== 'ok') return result;
    const ownerKey = user.keycloakId ?? user.id;
    const emailAddress = input.email_address.toLowerCase();
    const encryptedPassword = encrypt({ password: input.password });
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
          },
          update: {
            host: input.host.toLowerCase(),
            port: 993,
            username: input.username,
            encryptedPassword,
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

  async credentials(mailbox: MailboxAccount): Promise<ImapCredentials> {
    requireExternalImap();
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
    };
  }
}
