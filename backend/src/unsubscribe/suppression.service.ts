import { createHash, randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailEngagementKind, Prisma, SuppressedRecipientReason } from '@prisma/client';
import { normalizeAddress } from '../email/autonomy';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartMessageDetail } from '../stalwart/stalwart.types';

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

export interface HardBounceSweepOptions {
  mailboxId?: string | null;
  sinceDays?: number;
  dryRun?: boolean;
}

export interface HardBounceSweepResult {
  scanned: number;
  hard_bounces: number;
  added: number;
  already_present: number;
  skipped_soft: number;
}

type HardBounceCandidate = {
  email: string;
  messageId: string;
  note: string | null;
};

type HardBounceScan = {
  scanned: number;
  hardBounces: number;
  skippedSoft: number;
  candidates: HardBounceCandidate[];
};

const HARD_BOUNCE_PAGE_SIZE = 100;
const DEFAULT_HARD_BOUNCE_SINCE_DAYS = 7;

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
    @Optional() private readonly stalwart?: StalwartPort,
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

  /**
   * Scan recent sovereign mailbox messages for RFC 3464 hard-bounce DSNs.
   * James supplies `dsn` on the same thread-detail read used by the webmail
   * thread route; this method deliberately does not introduce another JMAP
   * shape or persist a mailbox cursor.
   */
  async sweepHardBounces(
    workspaceId: string,
    options: HardBounceSweepOptions = {},
  ): Promise<HardBounceSweepResult> {
    const sinceDays = options.sinceDays ?? DEFAULT_HARD_BOUNCE_SINCE_DAYS;
    if (!Number.isInteger(sinceDays) || sinceDays <= 0) {
      throw new BadRequestException('sinceDays must be a positive integer.');
    }

    const mailboxId = options.mailboxId?.trim() || null;
    const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const mailboxes = await this.prisma.withWorkspace(workspaceId, null, (tx) =>
      tx.mailboxAccount.findMany({
        where: {
          workspaceId,
          active: true,
          provider: 'stalwart',
          ...(mailboxId ? { id: mailboxId } : {}),
        },
        select: { id: true, emailAddress: true },
        orderBy: { createdAt: 'asc' },
      }),
    );

    if (mailboxId && mailboxes.length === 0) {
      throw new NotFoundException('Sovereign mailbox not found in this workspace.');
    }

    const result: HardBounceSweepResult = {
      scanned: 0,
      hard_bounces: 0,
      added: 0,
      already_present: 0,
      skipped_soft: 0,
    };
    const candidates: HardBounceCandidate[] = [];

    if (!this.stalwart) return result;
    for (const mailbox of mailboxes) {
      const scan = await this.scanMailboxHardBounces(mailbox.emailAddress, cutoff);
      result.scanned += scan.scanned;
      result.hard_bounces += scan.hardBounces;
      result.skipped_soft += scan.skippedSoft;
      candidates.push(...scan.candidates);
    }

    if (candidates.length === 0) return result;

    await this.prisma.withWorkspace(workspaceId, null, async (tx) => {
      for (const candidate of candidates) {
        const existing = await tx.suppressedRecipient.findFirst({
          where: { workspaceId, email: candidate.email },
          select: { id: true },
        });
        if (existing) result.already_present += 1;
        else result.added += 1;

        if (options.dryRun) continue;
        await tx.suppressedRecipient.upsert({
          where: { workspaceId_email: { workspaceId, email: candidate.email } },
          create: {
            workspaceId,
            email: candidate.email,
            reason: SuppressedRecipientReason.BOUNCED,
            source: `dsn:${candidate.messageId}`,
            note: candidate.note,
          },
          update: {
            reason: SuppressedRecipientReason.BOUNCED,
            source: `dsn:${candidate.messageId}`,
            note: candidate.note,
          },
        });
      }
    });

    return result;
  }

  private async scanMailboxHardBounces(mailbox: string, cutoff: number): Promise<HardBounceScan> {
    const scan: HardBounceScan = {
      scanned: 0,
      hardBounces: 0,
      skippedSoft: 0,
      candidates: [],
    };
    const seenMessages = new Set<string>();
    let offset = 0;

    while (true) {
      let page;
      try {
        page = await this.stalwart!.listFolderThreads(mailbox, {
          folder: 'inbox',
          limit: HARD_BOUNCE_PAGE_SIZE,
          offset,
          query: null,
        });
      } catch {
        break;
      }
      if (!page || page.threads.length === 0) break;

      let reachedCutoff = false;
      for (const thread of page.threads) {
        const threadTime = thread.lastMessageAt ? Date.parse(thread.lastMessageAt) : NaN;
        if (Number.isFinite(threadTime) && threadTime < cutoff) {
          reachedCutoff = true;
          break;
        }

        let details: StalwartMessageDetail[];
        try {
          details = await this.stalwart!.getThreadDetail(mailbox, thread.id);
        } catch {
          continue;
        }
        for (const detail of details) {
          if (seenMessages.has(detail.id)) continue;
          seenMessages.add(detail.id);
          const messageTime = detail.sentAt ? Date.parse(detail.sentAt) : NaN;
          if (!Number.isFinite(messageTime) || messageTime < cutoff) continue;
          scan.scanned += 1;

          const dsn = detail.dsn;
          const action = dsn?.action?.trim().toLowerCase();
          const status = dsn?.status?.trim() ?? '';
          if (action !== 'failed' || !status) continue;
          if (!this.isHardBounceStatus(status)) {
            scan.skippedSoft += 1;
            continue;
          }

          scan.hardBounces += 1;
          const email = this.dsnRecipient(dsn?.final_recipient);
          if (!email) continue;
          scan.candidates.push({
            email,
            messageId: detail.id,
            note: dsn?.diagnostic_code?.trim().slice(0, 120) || null,
          });
        }
      }
      if (reachedCutoff) break;

      const nextOffset = offset + page.threads.length;
      const hasMore =
        page.total !== undefined
          ? nextOffset < page.total
          : page.threads.length === HARD_BOUNCE_PAGE_SIZE;
      if (!hasMore) break;
      offset = nextOffset;
    }

    return scan;
  }

  private isHardBounceStatus(status: string): boolean {
    // RFC 3464 5.1.x is the mailbox/user-unknown family. The prefix also
    // covers the explicitly required 5.1.1, 5.1.2, 5.1.3, 5.1.6 and 5.1.10
    // codes without accidentally admitting 4.x.x or policy 5.2.x/5.7.x.
    return status.startsWith('5.1.');
  }

  private dsnRecipient(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const value = raw.includes(';') ? raw.slice(raw.indexOf(';') + 1).trim() : raw.trim();
    const email = normalizeAddress(value);
    return EMAIL_RE.test(email) ? email : null;
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
