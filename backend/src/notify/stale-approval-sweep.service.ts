/**
 * StaleApprovalSweepService — the Wave-9 hourly ESCALATION sweep.
 *
 * Real-time pings (StableNotifierService.notifyApprovalPending) tell a human the
 * moment an approval is staged; this sweep is the safety net for the ones nobody
 * acted on. Every hour it finds PENDING agent-inbox items older than 24h whose
 * last reminder was itself >24h ago, groups them into ONE "N approvals waiting,
 * oldest …" message, posts it via the notifier, and stamps each item so it isn't
 * re-reminded for another 24h.
 *
 * Follows the inbound-watcher's cron shape (an app-wide ScheduleModule.forRoot()
 * discovers the @Cron; a `running` latch prevents overlap; cross-tenant
 * enumeration uses the sanctioned systemClient/BYPASSRLS while every per-row
 * mutation stays fenced through withWorkspace). DORMANT by default: it no-ops
 * unless EMAIL_OPS_NOTIFY_ENABLED is on AND the notifier is configured.
 *
 * The "reminded" stamp lives at payload.notify.lastRemindedAt and is MERGED into
 * the existing payload — payload.policy (the hold reasons the approval UI renders)
 * and every other key are preserved. The stamp is written only after Stable ACKed
 * the post (confirm-on-success), so a failed post is retried next hour instead of
 * silently suppressing the reminder.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AgentInboxState, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { notifySweepEnabled } from './notify.flags';
import { AGENT_INBOX_DEEP_LINK, StableNotifierService } from './stable-notifier.service';

/** An item must be at least this old before it escalates. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** …and it is re-reminded at most once per this interval. */
export const REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Bullet cap in the digest — the rest collapse to "…and N more". */
export const MAX_BULLETS = 8;

/** Upper bound on the per-sweep cross-tenant scan (never an unbounded read). */
const SWEEP_SCAN_LIMIT = 500;

/** The subset of an AgentInboxItem the sweep reads. */
interface SweepRow {
  id: string;
  workspaceId: string;
  kind: string | null;
  summary: string | null;
  draftedBy: string | null;
  createdAt: Date;
  payload: Prisma.JsonValue | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The persisted last-reminder time (payload.notify.lastRemindedAt), or null. */
export function readLastReminded(payload: unknown): Date | null {
  if (!isRecord(payload)) return null;
  const notify = payload.notify;
  if (!isRecord(notify)) return null;
  const raw = notify.lastRemindedAt;
  if (typeof raw !== 'string' || !raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Merge the reminder stamp into a payload WITHOUT clobbering payload.policy or any
 * other key: shallow-clones the payload + its notify sub-object and sets only
 * lastRemindedAt.
 */
export function mergeNotifyStamp(payload: unknown, at: Date): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(payload) ? { ...payload } : {};
  const notify: Record<string, unknown> = isRecord(base.notify) ? { ...base.notify } : {};
  notify.lastRemindedAt = at.toISOString();
  base.notify = notify;
  return base;
}

/** ms → the coarsest human unit ("12d" / "5h" / "30m" / "10s"). */
export function humanAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}h`;
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

@Injectable()
export class StaleApprovalSweepService {
  private readonly logger = new Logger(StaleApprovalSweepService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: StableNotifierService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledSweep(): Promise<void> {
    if (!notifySweepEnabled()) return; // dormant until deliberately turned on
    if (this.notifier.isDormant()) return; // no room wired → nothing to post
    if (this.running) return; // never overlap a slow sweep with the next tick
    this.running = true;
    try {
      const reminded = await this.runSweep();
      if (reminded > 0) this.logger.log(`stale-approval sweep: reminded on ${reminded} pending item(s)`);
    } catch (err) {
      this.logger.warn(`stale-approval sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One sweep pass: find due PENDING items, post ONE grouped reminder, stamp each.
   * Returns how many items were reminded (0 = nothing due / post failed). `now` is
   * injectable for deterministic tests.
   */
  async runSweep(now: Date = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - STALE_AFTER_MS);
    // Cross-tenant enumeration via the sanctioned systemClient (BYPASSRLS), bounded
    // and oldest-first so the digest's "oldest …" and the bullet order are stable.
    const rows: SweepRow[] = await this.prisma.systemClient.agentInboxItem.findMany({
      where: { state: AgentInboxState.PENDING, createdAt: { lt: staleBefore } },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_SCAN_LIMIT,
      select: {
        id: true,
        workspaceId: true,
        kind: true,
        summary: true,
        draftedBy: true,
        createdAt: true,
        payload: true,
      },
    });

    // Due = never reminded, or last reminded > REMIND_INTERVAL_MS ago (JSON-field
    // predicate done in JS — cheaper + clearer than a Prisma JSON filter).
    const due = rows.filter((r) => {
      const last = readLastReminded(r.payload);
      return !last || now.getTime() - last.getTime() > REMIND_INTERVAL_MS;
    });
    if (due.length === 0) return 0;

    // ONE grouped message; post FIRST and only stamp on a confirmed delivery.
    const delivered = await this.notifier.notifyText(this.formatDigest(due, now));
    if (!delivered) return 0;

    let stamped = 0;
    for (const r of due) {
      try {
        const next = mergeNotifyStamp(r.payload, now);
        await this.prisma.withWorkspace(r.workspaceId, 'notify-sweep', (tx) =>
          // Fenced by id+workspace+state: never restamps a foreign or already-
          // reviewed item (an approval may have raced this sweep).
          tx.agentInboxItem.updateMany({
            where: { id: r.id, workspaceId: r.workspaceId, state: AgentInboxState.PENDING },
            data: { payload: next as Prisma.InputJsonValue },
          }),
        );
        stamped += 1;
      } catch (err) {
        // Degrade-clean: a stamp failure just means this item may re-remind next
        // sweep — never fatal to the rest.
        this.logger.warn(`stale-approval stamp failed for item ${r.id}: ${(err as Error).message}`);
      }
    }
    return stamped;
  }

  /** The grouped reminder: header + up to MAX_BULLETS lines + overflow + deep link. */
  formatDigest(due: SweepRow[], now: Date): string {
    const n = due.length;
    const oldestAge = humanAge(now.getTime() - due[0].createdAt.getTime());
    const header = `⏳ ${n} approval${n === 1 ? '' : 's'} waiting, oldest ${oldestAge}:`;

    const shown = due.slice(0, MAX_BULLETS);
    const bullets = shown.map((r) => `• ${this.bulletLine(r, now)}`);
    const remaining = n - shown.length;
    if (remaining > 0) bullets.push(`• …and ${remaining} more`);

    return [header, ...bullets, AGENT_INBOX_DEEP_LINK].join('\n');
  }

  /** One item's bullet: its summary (or a kind fallback) + its own age. */
  private bulletLine(r: SweepRow, now: Date): string {
    const age = humanAge(now.getTime() - r.createdAt.getTime());
    const label =
      (r.summary ?? '').trim() ||
      `${(r.kind ?? 'item').toLowerCase()} from ${(r.draftedBy ?? 'an agent').trim() || 'an agent'}`;
    return `${label} (${age})`;
  }
}
