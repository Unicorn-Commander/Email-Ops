import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { MailTriageService } from '../mail-triage/mail-triage.service';
import { MailRulesService } from '../mail-rules/mail-rules.service';
import { MailRuleRow } from '../mail-rules/mail-rules.types';
import { inboundWatcherEnabled } from '../common/workspace/feature-flags';
import { AgentReplyService } from '../agent-reply/agent-reply.service';

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
    private readonly rules: MailRulesService,
    private readonly agentReply: AgentReplyService,
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

    // Preload ALL enabled rules ONCE per sweep (the sanctioned systemClient
    // cross-tenant enumeration, same doctrine as the mailbox scan above) and
    // group by mailbox — pollOne then skips rules work instantly (no queries)
    // for mailboxes with none. Degrade-clean: a rules load failure warns and
    // the sweep still classifies (rules must never block triage).
    const rulesByMailbox = new Map<string, MailRuleRow[]>();
    try {
      const ruleRows = await this.prisma.systemClient.mailRule.findMany({
        where: { enabled: true },
        select: {
          id: true,
          workspaceId: true,
          mailboxId: true,
          enabled: true,
          priority: true,
          match: true,
          actions: true,
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      for (const row of ruleRows) {
        const group = rulesByMailbox.get(row.mailboxId);
        if (group) group.push(row);
        else rulesByMailbox.set(row.mailboxId, [row]);
      }
    } catch (err) {
      this.logger.warn(`inbound sweep: rules preload failed: ${(err as Error).message}`);
    }

    let total = 0;
    for (const mb of mailboxes) {
      try {
        total += await this.pollOne(mb, rulesByMailbox.get(mb.id));
      } catch (err) {
        this.logger.warn(`inbound poll failed for ${mb.emailAddress}: ${(err as Error).message}`);
      }
    }
    return total;
  }

  private async pollOne(
    mb: {
      id: string;
      workspaceId: string;
      emailAddress: string;
      inboundCursor: string | null;
      ownerKind: string;
    },
    mailboxRules?: MailRuleRow[],
  ): Promise<number> {
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
      if (mailboxRules?.length) {
        // The RULES ENGINE seam: applyInbound catches internally (degrade-clean),
        // and this guard is belt-and-braces — a rules failure must never block
        // triage of the remaining messages or the cursor advance below.
        try {
          await this.rules.applyInbound(mb.workspaceId, mb.id, mb.emailAddress, msg, mailboxRules);
        } catch (err) {
          this.logger.warn(`rules apply failed for ${mb.emailAddress}: ${(err as Error).message}`);
        }
      }
      if (mb.ownerKind === 'AGENT') {
        // Reply-routing seam: an agent received mail. The AGENT-REPLY RUNTIME
        // consumes this hand-off — it drafts a reply into the approval queue
        // (never auto-sends; dormant unless AGENT_REPLY_RUNTIME_ENABLED).
        this.logger.log(
          `inbound → AGENT ${mb.emailAddress} thread=${msg.threadId} from=${msg.fromAddress ?? '?'} (reply-routing seam)`,
        );
        // Fire-and-forget (same doctrine as the rules applicator above): the
        // service is degrade-clean internally, and this try/catch + .catch is
        // belt-and-braces — a draft failure (or a slow LLM turn) must NEVER
        // block triage of the remaining messages or the cursor advance below.
        try {
          void this.agentReply
            .draftReplyForInbound(
              mb.workspaceId,
              { id: mb.id, emailAddress: mb.emailAddress, workspaceId: mb.workspaceId },
              msg,
            )
            .catch((err) =>
              this.logger.warn(
                `agent-reply draft failed for ${mb.emailAddress}: ${(err as Error).message}`,
              ),
            );
        } catch (err) {
          this.logger.warn(
            `agent-reply hook failed for ${mb.emailAddress}: ${(err as Error).message}`,
          );
        }
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
