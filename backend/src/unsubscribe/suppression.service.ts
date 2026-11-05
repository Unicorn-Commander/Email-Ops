import { createHash, randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailEngagementKind, Prisma, SuppressedRecipientReason } from '@prisma/client';
import { normalizeAddress } from '../email/autonomy';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';

export const RECIPIENT_SUPPRESSED = 'recipient_suppressed';
export const RECIPIENT_SUPPRESSED_MESSAGE = 'The recipient is suppressed in this workspace.';
const UNKNOWN_UNSUBSCRIBE = 'Unsubscribe link not found.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SuppressionView {
  id: string;
  email: string;
  reason: SuppressedRecipientReason;
  source: string;
  note: string | null;
  createdAt: string;
}

type PublicToken = {
  id: string;
  workspaceId: string;
  email: string;
  kitId: string | null;
  messageId: string | null;
  usedAt: Date | null;
};

/**
 * The shared suppression and RFC 8058 token seam.
 *
 * Public token resolution is the one deliberately bounded system-client lookup
 * in this service: the hash is the only cross-workspace input, and every
 * mutation after resolution runs through PrismaService.withWorkspace(). No raw
 * token or recipient address is logged or returned from the public methods.
 */
@Injectable()
export class SuppressionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  normalizeEmail(raw: string): string {
    const email = normalizeAddress(raw);
    if (!EMAIL_RE.test(email)) throw new BadRequestException('A valid email address is required.');
    return email;
  }

  async list(
    workspaceId: string,
    ucUid: string | null,
    filter: { email?: string; reason?: SuppressedRecipientReason } = {},
  ): Promise<SuppressionView[]> {
    const email = filter.email ? this.normalizeEmail(filter.email) : undefined;
    const rows = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.suppressedRecipient.findMany({
        where: {
          workspaceId,
          ...(email ? { email } : {}),
          ...(filter.reason ? { reason: filter.reason } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    );
    return rows.map((row) => this.view(row));
  }

  async suppressManually(
    workspaceId: string,
    ucUid: string | null,
    rawEmail: string,
    note?: string | null,
  ): Promise<SuppressionView> {
    const email = this.normalizeEmail(rawEmail);
    const normalizedNote = (note ?? '').trim().slice(0, 2000) || null;
    const row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.suppressedRecipient.upsert({
        where: { workspaceId_email: { workspaceId, email } },
        create: {
          workspaceId,
          email,
          reason: SuppressedRecipientReason.MANUAL,
          source: `user:${ucUid ?? 'unknown'}`,
          note: normalizedNote,
        },
        update: {
          reason: SuppressedRecipientReason.MANUAL,
          source: `user:${ucUid ?? 'unknown'}`,
          note: normalizedNote,
        },
      }),
    );
    return this.view(row);
  }

  async remove(workspaceId: string, ucUid: string | null, id: string): Promise<boolean> {
    const result = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.suppressedRecipient.deleteMany({ where: { id, workspaceId } }),
    );
    return result.count > 0;
  }

  /** Return the first matching suppression for a transaction-scoped recipient set. */
  async findSuppressedInTx(tx: WorkspaceTxClient, workspaceId: string, recipients: string[]) {
    const emails = [
      ...new Set(recipients.map((recipient) => normalizeAddress(recipient)).filter(Boolean)),
    ];
    if (emails.length === 0) return null;
    return tx.suppressedRecipient.findFirst({
      where: { workspaceId, email: { in: emails } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async assertRecipientsNotSuppressed(
    tx: WorkspaceTxClient,
    workspaceId: string,
    recipients: string[],
  ): Promise<void> {
    if (await this.findSuppressedInTx(tx, workspaceId, recipients)) {
      throw new ForbiddenException(RECIPIENT_SUPPRESSED);
    }
  }

  /**
   * Create the one raw token that is returned to the mail engine as a header.
   * The database only receives its SHA-256 digest. A duplicate means a previous
   * attempt left a token row but no raw token is recoverable, so fail closed.
   */
  async prepareKitHeaders(
    tx: WorkspaceTxClient,
    workspaceId: string,
    rawEmail: string,
    kitId: string,
    messageId: string,
    fromAddress: string,
  ): Promise<{ name: string; value: string }[]> {
    const email = this.normalizeEmail(rawEmail);
    const sender = this.normalizeEmail(fromAddress);
    const existing = await tx.unsubscribeToken.findFirst({
      where: { workspaceId, email, messageId },
      select: { id: true },
    });
    if (existing) throw new ConflictException('unsubscribe_token_exists');

    const frontend = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/$/, '');
    const apiPrefix = (this.config.get<string>('API_PREFIX', 'api/v1') ?? 'api/v1').replace(
      /^\/+|\/+$/g,
      '',
    );
    if (!frontend) {
      throw new ServiceUnavailableException('public_unsubscribe_url_not_configured');
    }

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);
    await tx.unsubscribeToken.create({
      data: { workspaceId, tokenHash, email, kitId, messageId },
    });
    const url = `${frontend}/${apiPrefix}/u/${rawToken}`;
    return [
      {
        name: 'List-Unsubscribe',
        value: `<${url}>, <mailto:${sender}?subject=unsubscribe>`,
      },
      { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
    ];
  }

  async discardKitToken(
    tx: WorkspaceTxClient,
    workspaceId: string,
    messageId: string,
  ): Promise<void> {
    await tx.unsubscribeToken.deleteMany({ where: { workspaceId, messageId, usedAt: null } });
  }

  /** Used by GET only; returns no identity-bearing information. */
  async assertPublicToken(rawToken: string): Promise<void> {
    const row = await this.lookupPublicToken(rawToken);
    if (!row || row.usedAt) throw new NotFoundException(UNKNOWN_UNSUBSCRIBE);
  }

  /**
   * Consume a one-click token. The conditional update is the idempotence/race
   * fence; a second or already-used token gets the same generic 404 as an
   * unknown token and cannot reveal whether an address exists.
   */
  async consumeOneClick(rawToken: string): Promise<void> {
    const resolved = await this.lookupPublicToken(rawToken);
    if (!resolved || resolved.usedAt) throw new NotFoundException(UNKNOWN_UNSUBSCRIBE);

    await this.prisma.withWorkspace(resolved.workspaceId, null, async (tx) => {
      const claimed = await tx.unsubscribeToken.updateMany({
        where: { id: resolved.id, workspaceId: resolved.workspaceId, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) throw new NotFoundException(UNKNOWN_UNSUBSCRIBE);

      const source = resolved.kitId ?? resolved.messageId ?? 'one-click';
      await tx.suppressedRecipient.upsert({
        where: { workspaceId_email: { workspaceId: resolved.workspaceId, email: resolved.email } },
        create: {
          workspaceId: resolved.workspaceId,
          email: resolved.email,
          reason: SuppressedRecipientReason.UNSUBSCRIBED,
          source,
        },
        update: {
          reason: SuppressedRecipientReason.UNSUBSCRIBED,
          source,
        },
      });

      if (resolved.messageId) {
        const message = await tx.emailMessage.findFirst({
          where: { id: resolved.messageId, workspaceId: resolved.workspaceId },
          select: { id: true },
        });
        if (message) {
          const providerEventId = `unsubscribe:${resolved.id}`;
          await tx.emailEngagementEvent.upsert({
            where: {
              workspaceId_provider_providerEventId: {
                workspaceId: resolved.workspaceId,
                provider: 'email-ops',
                providerEventId,
              },
            },
            create: {
              workspaceId: resolved.workspaceId,
              emailMessageId: message.id,
              provider: 'email-ops',
              providerEventId,
              recordType: 'Unsubscribe',
              normalizedKind: EmailEngagementKind.UNSUBSCRIBED,
              raw: { source: 'one-click' } as Prisma.InputJsonValue,
            },
            update: {
              normalizedKind: EmailEngagementKind.UNSUBSCRIBED,
              recordType: 'Unsubscribe',
            },
          });
        }
      }
    });
  }

  private async lookupPublicToken(rawToken: string): Promise<PublicToken | null> {
    const tokenHash = this.hashToken(rawToken);
    return this.prisma.systemClient.unsubscribeToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        workspaceId: true,
        email: true,
        kitId: true,
        messageId: true,
        usedAt: true,
      },
    });
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private view(row: {
    id: string;
    email: string;
    reason: SuppressedRecipientReason;
    source: string;
    note: string | null;
    createdAt: Date;
  }): SuppressionView {
    return {
      id: row.id,
      email: row.email,
      reason: row.reason,
      source: row.source,
      note: row.note ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
