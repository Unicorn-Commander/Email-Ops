/**
 * MailTriageService — the inbound classification seam.
 *
 * `classifyInbound` is the single function the inbound mail pipeline calls when a
 * RECEIVED message lands (the webhook/JMAP-push path is engine-gated and not yet
 * built — this is the seam it plugs into). It composes the three app-layer spam
 * inputs, in precedence order, inside ONE workspace tx:
 *
 *   1. Sender policy (deterministic user/agent intent) — ALLOW ⇒ force INBOX +
 *      clean (trusted; overrides the engine); BLOCK ⇒ Spam.
 *   2. The engine verdict via SpamPort — 'spam' ⇒ Spam; otherwise INBOX. Dormant
 *      today (null verdict), so nothing is fabricated while the engine is asleep.
 *
 * It stamps the SoR rows for the thread with the engine score/verdict (best
 * effort — received mail may have no SoR row) and upserts the disposition overlay.
 * Workspace-scoped throughout (explicit predicate + withWorkspace).
 */

import { Injectable } from '@nestjs/common';
import { MessageDisposition } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SenderPolicyService } from './sender-policy.service';
import { SpamPort } from './spam.port';
import { ClassifyResult } from './mail-triage.types';

const SPAM_AGENT_KEY = 'spam-filter';

@Injectable()
export class MailTriageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly senderPolicy: SenderPolicyService,
    private readonly spam: SpamPort,
  ) {}

  async classifyInbound(
    workspaceId: string,
    ucUid: string | null,
    input: { threadId: string; fromAddress: string | null; subject?: string | null; body?: string | null },
  ): Promise<ClassifyResult> {
    // The engine call needs no DB tx; do it up front so the tx stays short.
    const policyApplies = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      this.senderPolicy.evaluate(tx, workspaceId, input.fromAddress),
    );

    if (policyApplies === 'ALLOW') {
      await this.applyDisposition(workspaceId, ucUid, input.threadId, MessageDisposition.INBOX, null, 'clean');
      return this.result(input.threadId, MessageDisposition.INBOX, null, 'clean', 'sender_allowed');
    }
    if (policyApplies === 'BLOCK') {
      await this.applyDisposition(workspaceId, ucUid, input.threadId, MessageDisposition.SPAM, null, 'spam');
      return this.result(input.threadId, MessageDisposition.SPAM, null, 'spam', 'sender_blocked');
    }

    const verdict = await this.spam.classify({
      fromAddress: input.fromAddress,
      subject: input.subject,
      body: input.body,
    });

    if (verdict.verdict === 'spam') {
      await this.applyDisposition(
        workspaceId,
        ucUid,
        input.threadId,
        MessageDisposition.SPAM,
        verdict.score,
        'spam',
      );
      return this.result(input.threadId, MessageDisposition.SPAM, verdict.score, 'spam', 'engine_verdict');
    }

    // Clean / unsure / no engine → leave in INBOX; stamp the score if we got one.
    if (verdict.score != null || verdict.verdict != null) {
      await this.stampScore(workspaceId, ucUid, input.threadId, verdict.score, verdict.verdict);
    }
    return this.result(
      input.threadId,
      MessageDisposition.INBOX,
      verdict.score,
      verdict.verdict,
      this.spam.isConfigured() ? 'engine_clean' : 'engine_dormant',
    );
  }

  /** Upsert the disposition + stamp the engine score on the thread's SoR rows (one tx). */
  private async applyDisposition(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
    disposition: MessageDisposition,
    score: number | null,
    verdict: 'clean' | 'spam' | 'unsure' | null,
  ): Promise<void> {
    await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      await tx.threadDisposition.upsert({
        where: { workspaceId_threadId: { workspaceId, threadId } },
        create: { workspaceId, threadId, disposition, setByAgentKey: SPAM_AGENT_KEY },
        update: { disposition, setByAgentKey: SPAM_AGENT_KEY },
      });
      if (score != null || verdict != null) {
        await tx.emailMessage.updateMany({
          where: { workspaceId, threadId },
          data: { spamScore: score, spamVerdict: verdict },
        });
      }
    });
  }

  private async stampScore(
    workspaceId: string,
    ucUid: string | null,
    threadId: string,
    score: number | null,
    verdict: 'clean' | 'spam' | 'unsure' | null,
  ): Promise<void> {
    await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.emailMessage.updateMany({
        where: { workspaceId, threadId },
        data: { spamScore: score, spamVerdict: verdict },
      }),
    );
  }

  private result(
    threadId: string,
    disposition: MessageDisposition,
    score: number | null,
    verdict: 'clean' | 'spam' | 'unsure' | null,
    reason: ClassifyResult['reason'],
  ): ClassifyResult {
    return { thread_id: threadId, disposition, spam_score: score, spam_verdict: verdict, reason };
  }
}
