/**
 * StableNotifierService — the Wave-9 APPROVAL-NOTIFICATION seam to Unicorn Stable
 * (team chat). When an agent stages something into the agent-inbox approval queue
 * (a held email draft, a cleanup batch) or the escalation sweep finds stale
 * approvals, this service posts a compact markdown message into a Stable room so a
 * human sees it without watching the queue.
 *
 * DORMANT unless EMAIL_OPS_NOTIFY_WEBHOOK_URL is set — with no URL every public
 * method is a no-op (the dormant-seam posture: a deploy that hasn't been wired to
 * a room does nothing). The transport is a single 5s POST to Stable's internal
 * agent-messages endpoint (the orchestrator wires the real host/token/room at
 * deploy); ONE attempt, no retries, and it NEVER throws — a notification failure
 * must never touch mail flow (degrade-clean).
 *
 * Env (read via an injectable EnvGetter — the agent-avatar.ts pattern — so unit
 * tests never mutate real process.env):
 *   - EMAIL_OPS_NOTIFY_WEBHOOK_URL   the internal post endpoint (absent → DORMANT)
 *   - EMAIL_OPS_NOTIFY_WEBHOOK_TOKEN bearer secret (optional; sent when present)
 *   - EMAIL_OPS_NOTIFY_ROOM          the livekit room slug to post into
 *   - EMAIL_OPS_NOTIFY_AGENT_ID      brigade agent id (default 'claude-code')
 */

import { Injectable, Logger, Optional } from '@nestjs/common';

type EnvGetter = (key: string) => string | undefined;

const defaultGetter: EnvGetter = (k) => process.env[k];

/** 5s, ONE attempt — a notify must never stall or retry-storm the mail path. */
export const NOTIFY_TIMEOUT_MS = 5000;

/** The brigade agent id the message is posted as, when none is configured. */
export const DEFAULT_NOTIFY_AGENT_ID = 'claude-code';

/** The human-facing approval queue the deep link points at. */
export const AGENT_INBOX_DEEP_LINK = 'https://email-ops.magicunicorn.dev/agent-inbox';

/** The compact descriptor of a freshly-staged approval, shaped for one message. */
export interface ApprovalPendingNotice {
  id: string;
  workspaceId: string;
  /** EMAIL | CLEANUP | SMS | … (the AgentInboxItem kind). */
  kind: string;
  summary?: string | null;
  draftedBy?: string | null;
  reasons?: { code: string; message: string }[];
  toAddress?: string | null;
  subject?: string | null;
}

@Injectable()
export class StableNotifierService {
  private readonly logger = new Logger(StableNotifierService.name);
  private readonly getEnv: EnvGetter;

  /**
   * The EnvGetter is an OPTIONAL, non-DI constructor arg (there is no provider for
   * a bare function token — @Optional() lets Nest inject `undefined` and we fall
   * back to process.env). Unit tests bypass Nest and pass a fake getter directly.
   */
  constructor(@Optional() getEnv?: EnvGetter) {
    this.getEnv = getEnv ?? defaultGetter;
  }

  private env(key: string): string {
    return (this.getEnv(key) ?? '').trim();
  }

  private get webhookUrl(): string | null {
    return this.env('EMAIL_OPS_NOTIFY_WEBHOOK_URL') || null;
  }

  private get token(): string | null {
    return this.env('EMAIL_OPS_NOTIFY_WEBHOOK_TOKEN') || null;
  }

  private get room(): string | null {
    return this.env('EMAIL_OPS_NOTIFY_ROOM') || null;
  }

  private get agentId(): string {
    return this.env('EMAIL_OPS_NOTIFY_AGENT_ID') || DEFAULT_NOTIFY_AGENT_ID;
  }

  /** DORMANT when no webhook URL is configured — every public method no-ops. */
  isDormant(): boolean {
    return this.webhookUrl === null;
  }

  /**
   * Post a compact approval-pending message (who drafted, To/subject or the
   * cleanup summary, the first hold reason in plain words, the deep link).
   * No-op while dormant; NEVER throws (fire-and-forget from the compose path).
   */
  async notifyApprovalPending(item: ApprovalPendingNotice): Promise<void> {
    if (this.isDormant()) return;
    await this.post(this.formatApprovalPending(item));
  }

  /**
   * Generic single-message post (the escalation sweep uses this). Returns true
   * only when Stable ACKed 2xx — the sweep gates its "reminded" stamp on that, so
   * a failed post is retried next hour instead of silently suppressed. No-op
   * (→ false) while dormant or on empty content; NEVER throws.
   */
  async notifyText(content: string): Promise<boolean> {
    if (this.isDormant()) return false;
    const body = (content ?? '').trim();
    if (!body) return false;
    return this.post(body);
  }

  /** The compact markdown for a freshly-staged approval. Pure — unit-tested. */
  formatApprovalPending(item: ApprovalPendingNotice): string {
    const who = (item.draftedBy ?? '').trim() || 'an agent';
    const lines = [`📥 Approval needed — ${this.kindLabel(item.kind)} drafted by ${who}`];

    const to = (item.toAddress ?? '').trim();
    const subject = (item.subject ?? '').trim();
    if (to || subject) {
      const parts: string[] = [];
      if (to) parts.push(`To: ${to}`);
      if (subject) parts.push(`Subject: ${subject}`);
      lines.push(parts.join(' · '));
    } else {
      const summary = (item.summary ?? '').trim();
      if (summary) lines.push(summary);
    }

    const reason = item.reasons?.[0]?.message?.trim();
    if (reason) lines.push(`Hold: ${reason}`);

    lines.push(AGENT_INBOX_DEEP_LINK);
    return lines.join('\n');
  }

  /** EMAIL → 'email', CLEANUP → 'cleanup', SMS → 'SMS', else the lowercased kind. */
  private kindLabel(kind: string): string {
    const k = (kind ?? '').trim().toUpperCase();
    if (k === 'SMS') return 'SMS';
    if (k === 'EMAIL') return 'email';
    if (k === 'CLEANUP') return 'cleanup';
    return k ? k.toLowerCase() : 'item';
  }

  /**
   * ONE 5s POST to Stable's internal agent-messages endpoint. Degrade-clean:
   * a missing room, a transport error, a non-2xx, or a timeout all just log and
   * return false — the caller (mail flow) is never affected.
   */
  private async post(content: string): Promise<boolean> {
    const url = this.webhookUrl;
    const room = this.room;
    if (!url) return false;
    if (!room) {
      this.logger.warn('Stable notify skipped: EMAIL_OPS_NOTIFY_ROOM is not set');
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          livekit_room_name: room,
          brigade_agent_id: this.agentId,
          content,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`Stable notify HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`Stable notify transport error: ${(err as Error).message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
