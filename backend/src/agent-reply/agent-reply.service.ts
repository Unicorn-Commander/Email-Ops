/**
 * AgentReplyService — the AGENT-REPLY RUNTIME (email an agent → it drafts the
 * answer → a human approves).
 *
 * The consumer of the inbound watcher's reply-routing seam: when a message
 * arrives at an ownerKind=AGENT sovereign mailbox, this service (a) resolves the
 * registered agent identity bound to that mailbox, (b) pulls the thread context
 * from the mail engine, (c) asks the Cleaner Engine LLM (/ai/chat — SERVICE
 * auth via X-Engine-Token, no per-user broker token involved) for a reply body,
 * and (d) stages it as a DRAFT through the ONE canonical staging lane —
 * EmailService.composeEmail(mode:'draft') — so it lands in the agent-inbox
 * approval queue with full provenance (draftedBy=agent key), the autonomy gate,
 * the audit log, and idempotency on (workspaceId, externalSource, externalRef).
 *
 * SAFETY DOCTRINE (v1, binding):
 *   - NEVER auto-send. Every reply is staged mode:'draft' regardless of the
 *     agent's autonomy dial — L0_DRAFT_ONLY, L1_APPROVE_TO_SEND, and even
 *     L2_AUTONOMOUS_AUDIT all land in the approval queue (requesting 'draft'
 *     means decideComposeMode honors it unconditionally; auto-send for L2 is a
 *     DELIBERATE deferral, not an oversight).
 *   - DORMANT unless AGENT_REPLY_RUNTIME_ENABLED=true (dormant-seam posture).
 *   - Respects the workspace kill switch (Workspace.agentsPaused — the same
 *     switch AgentControlsService toggles and composeEmail enforces) AND the
 *     per-agent pause, both checked BEFORE any engine/LLM work so a paused
 *     fleet does zero external calls.
 *   - Automated senders are SUPPRESSED: a no-reply/do-not-reply/bounce/
 *     postmaster style localpart never gets a drafted reply — nobody reads
 *     those, and each one pollutes the approval queue (isAutomatedSender).
 *   - LLM failures get ONE spaced retry: a single-slot local model under
 *     near-simultaneous drafts fails transiently, and unretried those inbound
 *     messages were silently never drafted. After the second failure the
 *     degrade-clean rule below applies unchanged.
 *   - DEGRADE-CLEAN: this service never throws. Any failure (engine dormant,
 *     LLM timeout, compose refusal) logs and returns null — a draft failure
 *     must never block the watcher's triage or cursor advance.
 *   - Idempotent: external_ref = `${mailboxId}:${threadId}:${receivedAt}` ⇒ one
 *     staged draft per inbound message; watcher retries are safe (composeEmail
 *     returns the existing row, queues nothing).
 */

import { Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../common/async/concurrency';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
import { EmailService } from '../email/email.service';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartMessageDetail } from '../stalwart/stalwart.types';
import { agentReplyRuntimeEnabled } from './agent-reply.flags';

/** The stable provenance slug for drafts staged by this runtime. */
export const AGENT_REPLY_SOURCE = 'agent-reply-runtime';

/** Thread-context caps: last N messages, bounded per-message and in total. */
const MAX_CONTEXT_MESSAGES = 5;
const MAX_MESSAGE_CHARS = 1500;
const MAX_DIGEST_CHARS = 6000;

/** Hard cap on the LLM turn (belt-and-braces over the engine client's own timeout). */
const LLM_TIMEOUT_MS = 30_000;

/**
 * The LLM turn gets ONE retry (2 attempts total) with a short pause between: a
 * single-slot local llama server under near-simultaneous drafts fails
 * transiently (in-band 'ai_unavailable:' / null / a hard-cap throw), and
 * without the retry those inbound messages were silently never drafted.
 */
const LLM_MAX_ATTEMPTS = 2;
const LLM_RETRY_DELAY_MS = 2_500;

/**
 * Localparts that mark an AUTOMATED sender (no human reads the reply): the
 * no-reply/do-not-reply spellings, tagged noreply forms (noreply+x / noreply.x
 * / noreply-x), and bounce plumbing (bounce/bounces/mailer-daemon/postmaster).
 * Anchored on the WHOLE localpart; isAutomatedSender adds the plain
 * 'noreply'/'no-reply' PREFIX catch on top (noreply123@, no-reply-alerts@, …).
 */
const AUTOMATED_LOCALPART_RE =
  /^(no-?reply|do-?not-?reply|donotreply|noreply[-+.].*|bounce|bounces|mailer-daemon|postmaster)$/i;

/**
 * True when an inbound from-address is an automated/no-reply sender. Drafting
 * a reply to one is pointless approval-queue pollution (live finding: agents
 * drafted replies to noreply@ notification mail), so the runtime skips these
 * before doing ANY work. Case-insensitive on the localpart (the part before
 * '@'; an address with no '@' is treated as all-localpart).
 */
export function isAutomatedSender(fromAddress: string): boolean {
  const localpart = fromAddress.trim().toLowerCase().split('@')[0] ?? '';
  if (!localpart) return false;
  return (
    AUTOMATED_LOCALPART_RE.test(localpart) ||
    localpart.startsWith('noreply') ||
    localpart.startsWith('no-reply')
  );
}

/** The AGENT mailbox the watcher polled (its shape in the watcher's sweep). */
export interface AgentReplyMailboxRef {
  id: string;
  emailAddress: string;
  workspaceId: string;
}

/** The newly-arrived inbound message (structurally InboundMessageRef). */
export interface AgentReplyInboundMsg {
  threadId: string;
  fromAddress: string | null;
  subject: string | null;
  /** ISO receivedAt from the poll — the idempotency component per message. */
  receivedAt?: string | null;
}

/** The registered-agent identity resolved for the receiving mailbox. */
interface ResolvedAgent {
  key: string;
  displayName: string;
  autonomyLevel: string;
  paused: boolean;
}

/** One message of the thread digest handed to the LLM. */
interface DigestMessage {
  from: string;
  subject: string;
  body: string;
}

@Injectable()
export class AgentReplyService {
  private readonly logger = new Logger(AgentReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stalwart: StalwartPort,
    private readonly engine: ConnectedAccountsEnginePort,
    private readonly email: EmailService,
  ) {}

  /**
   * Draft a reply to a message that just arrived at an AGENT mailbox and stage
   * it into the agent-inbox approval queue. Returns the staged SoR message id,
   * or null when skipped/failed (flag off, paused, no sender, LLM failure, …).
   * NEVER throws (degrade-clean — the watcher fire-and-forgets this).
   */
  async draftReplyForInbound(
    workspaceId: string,
    agentMailbox: AgentReplyMailboxRef,
    msg: AgentReplyInboundMsg,
  ): Promise<string | null> {
    // DORMANT unless deliberately enabled (checked FIRST — zero work while off).
    if (!agentReplyRuntimeEnabled()) {
      this.logger.debug(
        `agent-reply dormant (AGENT_REPLY_RUNTIME_ENABLED off) — skipping ${agentMailbox.emailAddress} thread=${msg.threadId}`,
      );
      return null;
    }

    try {
      // No sender → nothing to reply to. Self-mail → loop guard (an agent must
      // never draft a reply to its own outbound landing back in its inbox).
      const sender = (msg.fromAddress ?? '').trim();
      if (!sender) {
        this.logger.debug(
          `agent-reply skip: no from-address on thread=${msg.threadId} (${agentMailbox.emailAddress})`,
        );
        return null;
      }
      if (sender.toLowerCase() === agentMailbox.emailAddress.trim().toLowerCase()) {
        this.logger.debug(
          `agent-reply skip: self-addressed message on thread=${msg.threadId} (${agentMailbox.emailAddress})`,
        );
        return null;
      }
      // Automated senders (noreply@, do-not-reply@, bounce plumbing) never get
      // a drafted reply — nobody reads it, and each one pollutes the approval
      // queue. Checked BEFORE the gate read and the LLM so suppression is free.
      if (isAutomatedSender(sender)) {
        this.logger.debug(
          `agent-reply skip: automated sender '${sender}' on thread=${msg.threadId} (${agentMailbox.emailAddress})`,
        );
        return null;
      }

      // Pause switches + agent identity in ONE fenced read. The workspace kill
      // switch is the SAME stored bit AgentControlsService toggles
      // (Workspace.agentsPaused); composeEmail re-checks it, but checking here
      // first means a paused fleet does no thread read and no LLM call — and we
      // skip quietly instead of catching a ForbiddenException.
      const gate = await this.prisma.withWorkspace(workspaceId, null, async (tx) => {
        const ws = await tx.workspace.findUnique({
          where: { id: workspaceId },
          select: { agentsPaused: true, displayName: true },
        });
        return {
          agentsPaused: ws?.agentsPaused ?? false,
          workspaceName: ws?.displayName ?? workspaceId,
          agent: await this.resolveAgentForMailbox(
            tx,
            workspaceId,
            agentMailbox.id,
            agentMailbox.emailAddress,
          ),
        };
      });
      if (gate.agentsPaused) {
        this.logger.debug(
          `agent-reply skip: agents paused for workspace ${workspaceId} (thread=${msg.threadId})`,
        );
        return null;
      }
      if (gate.agent?.paused) {
        this.logger.debug(
          `agent-reply skip: agent '${gate.agent.key}' is paused (thread=${msg.threadId})`,
        );
        return null;
      }

      // Defaults when no registered agent is bound to the mailbox: draft under
      // the runtime's own provenance slug with the mailbox local-part as the
      // persona. (composeEmail then treats it as an UNREGISTERED source: the
      // From falls back to the workspace default mailbox, and a 'draft' request
      // is always honored — still nothing can auto-send.)
      const agentName =
        gate.agent?.displayName ?? agentMailbox.emailAddress.split('@')[0] ?? 'Email Agent';
      const draftedBy = gate.agent?.key ?? AGENT_REPLY_SOURCE;

      // Thread context via the mail engine (degrade-clean: [] on any failure).
      // DOCUMENTED CHOICE: an EMPTY thread detail still drafts — the latest
      // inbound's sender/subject alone is enough for a useful first draft, and
      // a human reviews every word before anything leaves.
      const detail = await this.stalwart.getThreadDetail(agentMailbox.emailAddress, msg.threadId);
      const digest = this.buildThreadDigest(detail ?? [], msg);

      // The LLM turn. /ai/chat frames `context` as an "Inbox context" JSON blob
      // and `message` as the user turn, so the drafting instruction rides in
      // `message` and the thread digest rides in `context`. Every failure shape
      // — a hard-cap throw, null, the engine's in-band "ai_unavailable:"
      // sentinel, or an empty draft — gets the ONE spaced retry
      // (LLM_MAX_ATTEMPTS) before degrading to skip.
      const instruction =
        `You are ${agentName}, an email agent for ${gate.workspaceName}. ` +
        'Draft a concise, professional reply to the latest message in the email thread ' +
        'provided in the context. Output ONLY the reply body text — no subject line, ' +
        'no signature placeholders, no commentary.';
      let body = '';
      for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
        let replyBody: string | null = null;
        try {
          replyBody = await withTimeout(
            this.engine.chat(instruction, {
              task: 'agent-reply-draft',
              agent: agentName,
              latest_message: {
                from: sender,
                subject: msg.subject ?? '(no subject)',
                received_at: msg.receivedAt ?? null,
              },
              thread: digest,
            }),
            LLM_TIMEOUT_MS,
            'agent-reply llm',
          );
        } catch (err) {
          this.logger.debug(
            `agent-reply LLM failed (attempt ${attempt}/${LLM_MAX_ATTEMPTS}) for thread=${msg.threadId} ` +
              `(${agentMailbox.emailAddress}): ${(err as Error).message}`,
          );
        }
        body = (replyBody ?? '').trim();
        // A usable draft ends the loop; any failure shape pauses once and retries.
        if (body && !body.toLowerCase().startsWith('ai_unavailable')) break;
        if (attempt < LLM_MAX_ATTEMPTS) await this.sleep(LLM_RETRY_DELAY_MS);
      }
      if (!body || body.toLowerCase().startsWith('ai_unavailable')) {
        this.logger.debug(
          `agent-reply LLM unavailable/empty for thread=${msg.threadId} (${agentMailbox.emailAddress}) — nothing staged`,
        );
        return null;
      }

      // Stage through the ONE canonical lane. mode:'draft' is honored
      // unconditionally by the autonomy gate (L0/L1/L2 alike land in the
      // approval queue — the v1 never-auto-send doctrine). draftedBy carries
      // the agent key so the AgentInboxItem is attributed to the registered
      // agent (composeEmail resolves the agent by this key and sends From its
      // primary mailbox on approve). external_ref makes retries idempotent:
      // ONE staged draft per inbound message.
      const externalRef = `${agentMailbox.id}:${msg.threadId}:${msg.receivedAt ?? 'na'}`;
      const staged = await this.email.composeEmail(workspaceId, null, {
        contactId: null,
        toAddress: sender,
        subject: this.replySubject(msg.subject),
        body,
        mode: 'draft',
        inReplyToThreadId: msg.threadId,
        externalSource: AGENT_REPLY_SOURCE,
        externalRef,
        draftedBy,
      });
      this.logger.log(
        `agent-reply staged draft ${staged.id} for ${agentMailbox.emailAddress} thread=${msg.threadId} ` +
          `(agent=${draftedBy}, autonomy=${gate.agent?.autonomyLevel ?? 'unregistered'} → approval queue)`,
      );
      return staged.id;
    } catch (err) {
      // Final backstop: the runtime NEVER throws into the watcher.
      this.logger.warn(
        `agent-reply draft failed for ${agentMailbox.emailAddress} thread=${msg.threadId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Resolve the registered agent bound to a mailbox: the AgentMailbox junction
   * (primary binding first — the agent whose From identity this mailbox is),
   * then the denormalized Agent.mailboxAccountId cache, then a SECOND CHANCE by
   * naming convention — key == the mailbox localpart (perry@… ↔ key 'perry';
   * live finding: a bindingless agent mailbox drafted as 'unregistered' even
   * though the matching agent row existed). Null when no active agent is
   * resolvable (the caller drafts under runtime defaults).
   */
  private async resolveAgentForMailbox(
    tx: WorkspaceTxClient,
    workspaceId: string,
    mailboxAccountId: string,
    emailAddress: string,
  ): Promise<ResolvedAgent | null> {
    const select = { key: true, displayName: true, autonomyLevel: true, paused: true };
    const binding = await tx.agentMailbox.findFirst({
      where: { workspaceId, mailboxAccountId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { agentId: true },
    });
    if (binding) {
      const agent = await tx.agent.findFirst({
        where: { id: binding.agentId, workspaceId, active: true },
        select,
      });
      if (agent) return agent;
    }
    const byCache = await tx.agent.findFirst({
      where: { workspaceId, mailboxAccountId, active: true },
      select,
    });
    if (byCache) return byCache;
    // Agent keys are canonical lowercase slugs, so match the lowercased
    // localpart exactly (same fenced tx, workspace-scoped, active-only).
    const localpart = emailAddress.trim().toLowerCase().split('@')[0] ?? '';
    if (!localpart) return null;
    return tx.agent.findFirst({
      where: { workspaceId, key: localpart, active: true },
      select,
    });
  }

  /**
   * The retry pause, isolated so unit tests can fake it (a spy/mock instead of
   * a real 2.5s wait). Protected rather than private for exactly that reason.
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** "Re: <subject>" without stacking Re:s; a missing subject still threads. */
  private replySubject(subject: string | null): string {
    const s = (subject ?? '').trim();
    if (!s) return 'Re: (no subject)';
    return /^re:/i.test(s) ? s : `Re: ${s}`;
  }

  /**
   * The last MAX_CONTEXT_MESSAGES of the thread as a compact sender/subject/body
   * digest (text preferred, HTML stripped, preview as last resort), bounded
   * per-message and in total so a huge thread can't blow the prompt budget.
   * Empty detail → a single-entry digest built from the inbound ref alone.
   */
  private buildThreadDigest(
    detail: StalwartMessageDetail[],
    msg: AgentReplyInboundMsg,
  ): DigestMessage[] {
    const chronological = [...detail].sort(
      (a, b) => new Date(a.sentAt ?? 0).getTime() - new Date(b.sentAt ?? 0).getTime(),
    );
    const recent = chronological.slice(-MAX_CONTEXT_MESSAGES);
    const digest: DigestMessage[] = [];
    let total = 0;
    // Walk NEWEST-first so the total cap trims the oldest context, never the
    // latest message (the one being replied to); then restore order.
    for (const m of [...recent].reverse()) {
      const body = this.extractBody(m).slice(0, MAX_MESSAGE_CHARS);
      const entry: DigestMessage = {
        from: m.from ? `${m.from.name ?? ''} <${m.from.address}>`.trim() : '(unknown sender)',
        subject: m.subject ?? '(no subject)',
        body,
      };
      const size = entry.from.length + entry.subject.length + entry.body.length;
      if (digest.length > 0 && total + size > MAX_DIGEST_CHARS) break;
      digest.push(entry);
      total += size;
    }
    digest.reverse();
    if (digest.length === 0) {
      digest.push({
        from: msg.fromAddress ?? '(unknown sender)',
        subject: msg.subject ?? '(no subject)',
        body: '(message body unavailable — reply from the subject and sender alone)',
      });
    }
    return digest;
  }

  /** Best body text for one message: text > stripped HTML > preview. */
  private extractBody(m: StalwartMessageDetail): string {
    if (m.textBody && m.textBody.trim()) return m.textBody.trim();
    if (m.htmlBody && m.htmlBody.trim()) return this.stripHtml(m.htmlBody);
    return (m.preview ?? '').trim();
  }

  /** Minimal HTML→text: drop style/script, strip tags, unescape, collapse. */
  private stripHtml(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
}
