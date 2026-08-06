/**
 * AgentReplyService — the AGENT-REPLY RUNTIME (email an agent → it answers;
 * the autonomy gate decides whether the answer SENDS or stages for approval).
 *
 * The consumer of the inbound watcher's reply-routing seam: when a message
 * arrives at an ownerKind=AGENT sovereign mailbox, this service (a) resolves the
 * registered agent identity bound to that mailbox, (b) pulls the thread context
 * from the mail engine, (c) asks the Cleaner Engine LLM (/ai/chat — SERVICE
 * auth via X-Engine-Token, no per-user broker token involved) for a reply body,
 * and (d) hands it to the ONE canonical compose lane — EmailService.composeEmail
 * — with full provenance (draftedBy=agent key), so the Wave-7 autonomy MATRIX
 * decides send-vs-draft, the audit log records the outcome, and idempotency on
 * (workspaceId, externalSource, externalRef) survives watcher retries.
 *
 * SAFETY DOCTRINE (Wave 7, binding):
 *   - The runtime REQUESTS 'send' for a REGISTERED agent and lets the compose
 *     gate decide ("first contact needs a human; ongoing conversation flows"):
 *     L0 → draft; L1 → internal-only autonomous; L2 → internal + ROUTINE
 *     external (in-thread, all-trusted, no attachments, ≤5 external, switch on).
 *     An UNREGISTERED mailbox persona still requests 'draft' — nothing
 *     unregistered can auto-send.
 *   - LOOP PROTECTION (all four, Wave 7): (a) every runtime send is stamped
 *     X-UC-Agent-Autoreply:1; (b) an inbound carrying that stamp is never
 *     answered; (c) an inbound FROM a same-workspace agent-linked mailbox is
 *     never answered (inter-agent tasking belongs to Brigade, not auto-reply
 *     ping-pong); (d) ≥5 runtime auto-SENDS in a thread in 24h → the next reply
 *     stages for approval (reason 'thread-rate-cap').
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
 *     compose per inbound message; watcher retries are safe (composeEmail
 *     returns the existing row, queues nothing).
 */

import { Injectable, Logger } from '@nestjs/common';
import { EmailMode } from '@prisma/client';
import { agentAvatarAbsoluteUrl } from '../agents/agent-avatar';
import { withTimeout } from '../common/async/concurrency';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
import { EmailService } from '../email/email.service';
import { AGENT_REPLY_RUNTIME_SOURCE } from '../email/email.types';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { StalwartPort } from '../stalwart/stalwart.port';
import { StalwartMessageDetail } from '../stalwart/stalwart.types';
import { agentDraftsPerMailboxPerDay, agentReplyRuntimeEnabled } from './agent-reply.flags';

/** The stable provenance slug for composes staged/sent by this runtime. */
export const AGENT_REPLY_SOURCE = AGENT_REPLY_RUNTIME_SOURCE;

/**
 * Loop protection (d): at most this many runtime auto-SENDS per thread per
 * rolling 24h window; the next reply stages for approval ('thread-rate-cap').
 */
export const THREAD_AUTO_SEND_CAP = 5;
const THREAD_AUTO_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The per-MAILBOX runtime-draft cap window (rolling 24h) — the spam-blast guard. */
const MAILBOX_DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Reply-quoting: hard cap on the quoted original (a "…" marker follows a truncation). */
const MAX_QUOTE_CHARS = 2000;

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
  /** True when the inbound carries the X-UC-Agent-Autoreply stamp (loop guard b). */
  agentAutoreply?: boolean;
}

/** The registered-agent identity resolved for the receiving mailbox. */
interface ResolvedAgent {
  key: string;
  displayName: string;
  description?: string | null;
  avatarUrl?: string | null;
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
      // Loop guard (b): the inbound is itself a runtime auto-reply (it carries
      // the X-UC-Agent-Autoreply stamp) — answering it would ping-pong forever.
      if (msg.agentAutoreply === true) {
        this.logger.log(
          `agent-reply skip: inbound carries X-UC-Agent-Autoreply (loop guard) on thread=${msg.threadId} (${agentMailbox.emailAddress})`,
        );
        return null;
      }

      // Pause switches + agent identity + the Wave-7 loop-protection reads in
      // ONE fenced read. The workspace kill switch is the SAME stored bit
      // AgentControlsService toggles (Workspace.agentsPaused); composeEmail
      // re-checks it, but checking here first means a paused fleet does no
      // thread read and no LLM call — and we skip quietly instead of catching a
      // ForbiddenException.
      const capSince = new Date(Date.now() - THREAD_AUTO_SEND_WINDOW_MS);
      const mailboxSince = new Date(Date.now() - MAILBOX_DRAFT_WINDOW_MS);
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
          // Loop guard (c): is the SENDER a same-workspace agent-linked mailbox?
          senderIsAgentMailbox: await this.isAgentMailboxAddress(tx, workspaceId, sender),
          // Loop guard (d): runtime auto-SENDS already in this thread inside the
          // rolling window (mode=SEND rows under the runtime provenance — the
          // gate-coerced drafts keep mode DRAFT and never count).
          threadAutoSends: await tx.emailMessage.count({
            where: {
              workspaceId,
              externalSource: AGENT_REPLY_SOURCE,
              mode: EmailMode.SEND,
              inReplyToThreadId: msg.threadId,
              createdAt: { gt: capSince },
            },
          }),
          // Wave 9 spam-blast guard: ALL runtime composes (any mode) for THIS
          // agent mailbox in the last 24h. externalRef is `${mailboxId}:...` for
          // every runtime compose off this box, so a prefix match is the cheapest
          // CORRECT "this mailbox" predicate (equality-pinned workspace+source
          // range-scan on externalRef) and covers registered + unregistered alike.
          mailboxComposes24h: await tx.emailMessage.count({
            where: {
              workspaceId,
              externalSource: AGENT_REPLY_SOURCE,
              externalRef: { startsWith: `${agentMailbox.id}:` },
              createdAt: { gt: mailboxSince },
            },
          }),
          // Wave 7 outbound quality: respect a stored default signature for the
          // sending mailbox instead of inventing one.
          signature:
            (await tx.mailSignature.findFirst({
              where: { workspaceId, mailboxAccountId: agentMailbox.id, isDefault: true },
              select: { html: true },
            })) ??
            (await tx.mailSignature.findFirst({
              where: { workspaceId, mailboxAccountId: agentMailbox.id },
              select: { html: true },
              orderBy: { createdAt: 'asc' },
            })),
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
      // Loop guard (c): inter-agent mail is Brigade's plane, not auto-reply's.
      if (gate.senderIsAgentMailbox) {
        this.logger.log(
          `agent-reply skip: sender '${sender}' is an agent-linked mailbox in this workspace (loop guard) — thread=${msg.threadId}`,
        );
        return null;
      }
      // Wave 9 spam-blast guard: this mailbox has already produced its daily cap
      // of runtime composes. Skip ENTIRELY here (before the thread read + LLM) so a
      // looping/compromised agent burns no LLM cost and stages no further drafts.
      // Distinct from loop guard (d): that caps per-THREAD auto-SENDS; this caps
      // per-MAILBOX total composes (any mode) in 24h.
      const mailboxCap = agentDraftsPerMailboxPerDay();
      if (gate.mailboxComposes24h >= mailboxCap) {
        this.logger.warn(
          `agent-reply skip: mailbox draft cap reached for ${agentMailbox.emailAddress} ` +
            `(${gate.mailboxComposes24h}/${mailboxCap} runtime composes in 24h) — thread=${msg.threadId}`,
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
        'no commentary, and do NOT write a closing sign-off, valediction, or signature ' +
        '(no "Best regards", no name line): a signature block is appended automatically, ' +
        'so end after your last substantive sentence. Do NOT claim to attach files.';
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

      // Wave 7/8 outbound quality: clean simple HTML (paragraphs from the LLM
      // text) + a signature block — the mailbox's stored default signature when
      // one exists, else the generated avatar card (displayName ONLY: the
      // registry description is internal documentation, not correspondence
      // identity — NEVER reintroduce it) with the agent's avatar + an AI tag.
      // The transparency footer is handed separately: composeEmail appends it
      // ONLY when the gate decides an AUTONOMOUS send to an external recipient
      // (a human-approved draft keeps just the normal signature).
      const avatarIdentity = {
        key: gate.agent?.key ?? agentMailbox.emailAddress.split('@')[0] ?? null,
        avatarUrl: gate.agent?.avatarUrl ?? null,
      };
      const signatureHtml = gate.signature?.html
        ? gate.signature.html
        : this.generatedSignatureHtml(agentName, avatarIdentity);
      const signatureText = gate.signature?.html
        ? this.stripHtml(gate.signature.html)
        : `${agentName} · AI agent`;
      // Wave 9: quote the original below the reply, mail-convention style. The
      // quote sits BETWEEN the body and the signature block (the transparency
      // footer placement, appended later by composeEmail, is unchanged). No quote
      // source (empty thread detail) → body flows straight into the signature.
      const quoted = this.buildQuotedOriginal(detail ?? [], msg);
      const bodyText = quoted
        ? `${body}\n\n${quoted.text}\n\n--\n${signatureText}`
        : `${body}\n\n--\n${signatureText}`;
      const bodyHtml = `${this.paragraphsToHtml(body)}${quoted ? quoted.html : ''}${signatureHtml}`;

      // Compose through the ONE canonical lane and LET THE GATE DECIDE (Wave 7):
      // a REGISTERED agent requests 'send' — the autonomy matrix sends internal
      // (L1+) / routine-external (L2) mail and stages everything else; an
      // UNREGISTERED persona still requests 'draft' (nothing unregistered can
      // auto-send). Over the per-thread cap (loop guard d) the runtime itself
      // requests 'draft' and passes the reason for the approval card.
      // draftedBy carries the agent key so the item/audit rows are attributed to
      // the registered agent. external_ref makes retries idempotent: ONE compose
      // per inbound message.
      const overCap = gate.threadAutoSends >= THREAD_AUTO_SEND_CAP;
      const requestedMode: 'send' | 'draft' = gate.agent && !overCap ? 'send' : 'draft';
      const externalRef = `${agentMailbox.id}:${msg.threadId}:${msg.receivedAt ?? 'na'}`;
      const staged = await this.email.composeEmail(workspaceId, null, {
        contactId: null,
        toAddress: sender,
        subject: this.replySubject(msg.subject),
        body: bodyText,
        bodyHtml,
        mode: requestedMode,
        inReplyToThreadId: msg.threadId,
        externalSource: AGENT_REPLY_SOURCE,
        externalRef,
        draftedBy,
        // Loop guard (a): every runtime send is stamped X-UC-Agent-Autoreply.
        agentAutoreply: true,
        // The matrix's not-cold-outbound proof: this IS a reply to a real
        // inbound from `sender` (the runtime watched it arrive).
        inboundReplyAttestation: { fromAddress: sender },
        ...(overCap
          ? {
              policyReasons: [
                {
                  code: 'thread-rate-cap',
                  message: `Auto-send cap reached for this thread (${THREAD_AUTO_SEND_CAP} in 24h) — this reply needs a human approval.`,
                },
              ],
            }
          : {}),
        // Name-free: the signature directly above already carries the agent's
        // name — repeating it here read as a stutter in live mail.
        transparencyFooter: {
          text: `\n\nSent autonomously · AI agent`,
          html: `<p style="color:#6b7280;font-size:12px;margin-top:16px">Sent autonomously · AI agent</p>`,
        },
      });
      const autoSent = staged.mode === 'send';
      this.logger.log(
        `agent-reply ${autoSent ? `AUTO-SENT (${staged.status})` : 'staged draft → approval queue'} ` +
          `${staged.id} for ${agentMailbox.emailAddress} thread=${msg.threadId} ` +
          `(agent=${draftedBy}, autonomy=${gate.agent?.autonomyLevel ?? 'unregistered'}, ` +
          `requested=${requestedMode}${overCap ? ', thread-rate-cap' : ''})`,
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
    const select = {
      key: true,
      displayName: true,
      description: true,
      avatarUrl: true,
      autonomyLevel: true,
      paused: true,
    };
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
   * Loop guard (c): is `address` a same-workspace AGENT-LINKED mailbox (Class
   * B — ownerKind AGENT, the Agent.mailboxAccountId cache, or an AgentMailbox
   * junction row with an active agent)? An agent must never auto-reply to
   * another agent's mail — that tasking plane belongs to Brigade.
   */
  private async isAgentMailboxAddress(
    tx: WorkspaceTxClient,
    workspaceId: string,
    address: string,
  ): Promise<boolean> {
    const row = await tx.mailboxAccount.findFirst({
      where: { workspaceId, emailAddress: { equals: address.trim(), mode: 'insensitive' } },
      select: { id: true, ownerKind: true },
    });
    if (!row) return false;
    if ((row.ownerKind as string) === 'AGENT') return true;
    const byCache = await tx.agent.findFirst({
      where: { workspaceId, active: true, mailboxAccountId: row.id },
      select: { id: true },
    });
    if (byCache) return true;
    const byJoin = await tx.agentMailbox.findFirst({
      where: { workspaceId, mailboxAccountId: row.id, agent: { active: true } },
      select: { id: true },
    });
    return !!byJoin;
  }

  /** LLM plain text → minimal clean HTML: escaped, double-newline paragraphs, single-newline breaks. */
  private paragraphsToHtml(text: string): string {
    return text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${this.escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  /**
   * The generated signature block when the mailbox stores none (Wave 8): a
   * small email-client-safe card — table layout + inline styles only (no
   * flex/grid) — [round 40×40 avatar, ABSOLUTE URL] · displayName (semibold) ·
   * a subtle bordered "AI AGENT" pill. One clean line, nothing else:
   * displayName ONLY — the agent registry description is internal governance
   * documentation and must never ride along on outbound correspondence.
   *
   * Mail clients often block remote images: the block still reads fine with
   * images off (alt text carries the name; the name cell renders regardless).
   * The transparency footer stays separate (email.service appends it on
   * autonomous external sends only) — no duplicate AI tagging there.
   */
  private generatedSignatureHtml(
    displayName: string,
    identity: { key?: string | null; avatarUrl?: string | null },
  ): string {
    const name = this.escapeHtml(displayName);
    const avatarUrl = this.escapeHtml(agentAvatarAbsoluteUrl(identity));
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;border-collapse:collapse">` +
      `<tr>` +
      `<td style="padding:0 10px 0 0;vertical-align:middle">` +
      `<img src="${avatarUrl}" width="40" height="40" alt="${name}" style="display:block;width:40px;height:40px;border-radius:50%;border:0" />` +
      `</td>` +
      `<td style="vertical-align:middle;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">` +
      `<span style="font-size:14px;font-weight:600;color:#111827">${name}</span>` +
      `<span style="display:inline-block;margin-left:8px;padding:1px 7px;border:1px solid #d1d5db;border-radius:999px;font-size:10px;font-weight:600;letter-spacing:0.05em;color:#6b7280;vertical-align:2px">AI AGENT</span>` +
      `</td>` +
      `</tr>` +
      `</table>`
    );
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  /**
   * Wave 9: the quoted-original block that rides BELOW the reply body (and ABOVE
   * the signature). Sources the message being replied to from the thread detail,
   * takes its best body text (text > stripped HTML > preview), truncates at
   * MAX_QUOTE_CHARS with a "…" marker, and formats both mail parts:
   *   text: `On <date>, <from> wrote:\n> line\n> line…`
   *   html: an "On …, … wrote:" line + a bordered <blockquote> (escaped, <br>/line).
   * Returns null when there is nothing to quote (empty detail / empty source body).
   */
  private buildQuotedOriginal(
    detail: StalwartMessageDetail[],
    msg: AgentReplyInboundMsg,
  ): { text: string; html: string } | null {
    const source = this.quotedSourceMessage(detail, msg);
    if (!source) return null;
    const raw = this.extractBody(source);
    if (!raw) return null;

    const truncated = raw.length > MAX_QUOTE_CHARS ? `${raw.slice(0, MAX_QUOTE_CHARS)}…` : raw;
    const fromLabel = source.from
      ? source.from.name
        ? `${source.from.name} <${source.from.address}>`
        : source.from.address
      : (msg.fromAddress ?? '(unknown sender)');
    const attribution = `On ${this.humanDate(source.sentAt)}, ${fromLabel} wrote:`;
    const lines = truncated.split('\n');

    const text = `${attribution}\n${lines.map((l) => `> ${l}`).join('\n')}`;
    const html =
      `<p style="margin:16px 0 0;color:#6b7280;font-size:13px">${this.escapeHtml(attribution)}</p>` +
      `<blockquote style="margin:12px 0 0;padding-left:12px;border-left:2px solid #d1d5db;color:#6b7280">` +
      `${lines.map((l) => this.escapeHtml(l)).join('<br>')}` +
      `</blockquote>`;
    return { text, html };
  }

  /** The message being replied to: newest from the inbound sender, else newest overall. */
  private quotedSourceMessage(
    detail: StalwartMessageDetail[],
    msg: AgentReplyInboundMsg,
  ): StalwartMessageDetail | null {
    if (!detail.length) return null;
    const byTimeDesc = [...detail].sort(
      (a, b) => new Date(b.sentAt ?? 0).getTime() - new Date(a.sentAt ?? 0).getTime(),
    );
    const sender = (msg.fromAddress ?? '').trim().toLowerCase();
    if (sender) {
      const fromSender = byTimeDesc.find(
        (m) => (m.from?.address ?? '').trim().toLowerCase() === sender,
      );
      if (fromSender) return fromSender;
    }
    return byTimeDesc[0] ?? null;
  }

  /** A stable, TZ-independent human date for a quote attribution ("Jul 20, 2026 at 15:45 UTC"). */
  private humanDate(iso: string | null | undefined): string {
    if (!iso) return 'an earlier message';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'an earlier message';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hh}:${mm} UTC`;
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
