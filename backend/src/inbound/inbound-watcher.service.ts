import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { MailTriageService } from '../mail-triage/mail-triage.service';
import { inboundWatcherEnabled } from '../common/workspace/feature-flags';

/**
 * The inbound half of the agent-email fabric: a per-mailbox JMAP delta poll that
 * turns a message ARRIVING at a sovereign James mailbox into (a) an app-layer
 * classification (sender-policy + SpamPort → disposition — this is the single
 * caller that finally lights up MailTriageService.classifyInbound) and (b) a
 * reply-routing signal for AGENT mailboxes (email an agent → it can answer; the
 * Brigade runtime that drafts the reply into the approval queue is the external
 * follow-up this seam hands off to).
 *
 * DORMANT by default (INBOUND_WATCHER_ENABLED unset/false) so it deploys inert
 * and is enabled + verified deliberately — the codebase's dormant-seam posture.
 * Cross-tenant enumeration uses the sanctioned systemClient (BYPASSRLS); every
 * per-row mutation stays fenced through withWorkspace.
 */
@Injectable()
export class InboundWatcherService {
  private readonly logger = new Logger(InboundWatcherService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
    private readonly triage: MailTriageService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async scheduledSweep(): Promise<void> {
    if (!inboundWatcherEnabled()) return; // inert until deliberately turned on
    if (this.running) return; // never overlap a slow sweep with the next tick
    this.running = true;
    try {
      const seen = await this.runSweep();
      if (seen > 0) this.logger.log(`inbound sweep: classified ${seen} new message(s)`);
    } catch (err) {
      this.logger.warn(`inbound sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Poll every sovereign mailbox once; returns how many new messages were classified. */
  async runSweep(): Promise<number> {
    const mailboxes = await this.prisma.systemClient.mailboxAccount.findMany({
      where: { provider: 'stalwart', active: true },
      select: {
        id: true,
        workspaceId: true,
        emailAddress: true,
        inboundCursor: true,
        ownerKind: true,
      },
      take: 500,
      orderBy: { updatedAt: 'asc' },
    });

    let total = 0;
    for (const mb of mailboxes) {
      try {
        total += await this.pollOne(mb);
      } catch (err) {
        this.logger.warn(`inbound poll failed for ${mb.emailAddress}: ${(err as Error).message}`);
      }
    }
    return total;
  }

  private async pollOne(mb: {
    id: string;
    workspaceId: string;
    emailAddress: string;
    inboundCursor: string | null;
    ownerKind: string;
  }): Promise<number> {
    const result = await this.stalwart.pollInbound(mb.emailAddress, mb.inboundCursor);
    if (!result) return 0; // engine dormant / degrade-clean

    for (const msg of result.newMessages) {
      // The spam/sender-policy seam finally has a caller: ALLOW→INBOX, BLOCK→Spam,
      // else the (dormant-until-engine) SpamPort verdict; stamps the overlay + SoR.
      await this.triage.classifyInbound(mb.workspaceId, 'inbound-watcher', {
        threadId: msg.threadId,
        fromAddress: msg.fromAddress,
        subject: msg.subject,
      });
      if (mb.ownerKind === 'AGENT') {
        // Reply-routing seam: an agent received mail. The Brigade runtime that
        // drafts a reply into the approval queue consumes this hand-off (follow-up).
        this.logger.log(
          `inbound → AGENT ${mb.emailAddress} thread=${msg.threadId} from=${msg.fromAddress ?? '?'} (reply-routing seam)`,
        );
      }
    }

    // Advance the persisted high-water mark (baseline included) — fenced write.
    if (result.cursor && result.cursor !== mb.inboundCursor) {
      await this.prisma.withWorkspace(mb.workspaceId, 'inbound-watcher', (tx) =>
        tx.mailboxAccount.update({ where: { id: mb.id }, data: { inboundCursor: result.cursor } }),
      );
    }
    return result.newMessages.length;
  }
}
