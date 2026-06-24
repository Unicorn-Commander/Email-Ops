'use client';

/**
 * Email Health panel — the compact "is email healthy?" status card.
 *
 * A single glance answer to "can the fleet send mail right now?" for an operator
 * (and, conceptually, a Mail-Ops steward agent): an overall ok / attention /
 * degraded badge over the setup posture (engine, default mailbox, mailbox &
 * agent counts) + the approval-queue health (pending, oldest age, recent
 * failures) + the individual signals the backend rolled up.
 *
 * Self-contained like `useAgentInboxPendingCount`: it resolves the active
 * workspace and fetches once on mount, is resilient by design (any failure → an
 * inline message, never throws), and never redirects (it must never hijack the
 * page it sits on). Calm Control: compact, low-chrome, no spinners beyond a
 * skeleton.
 */

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Skeleton, cn, type BadgeVariant } from '@/components/ui';
import {
  fetchMyWorkspaces,
  getEmailHealth,
  type EmailHealthReport,
  type HealthLevel,
} from '@/lib/api';
import { pickActiveWorkspace } from '@/lib/workspace';

type Load = 'loading' | 'ready' | 'error' | 'no-workspace';

/** Overall rollup → badge tone + human label. */
const OVERALL: Record<EmailHealthReport['status'], { label: string; tone: BadgeVariant }> = {
  ok: { label: 'Healthy', tone: 'success' },
  attention: { label: 'Needs attention', tone: 'warning' },
  degraded: { label: 'Degraded', tone: 'danger' },
};

/** Per-check dot colour. */
const DOT: Record<HealthLevel, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  fail: 'bg-danger',
};

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  return fallback;
}

/** A compact "Nm ago" / "Nh ago" from an ISO timestamp (best-effort). */
function relativeFrom(iso: string): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Render an "age in hours" as the most readable hours/days phrasing. */
function ageLabel(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return '< 1h';
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = hours / 24;
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}d`;
}

export function EmailHealthPanel() {
  const [report, setReport] = useState<EmailHealthReport | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchReport = useCallback(async (initial: boolean) => {
    if (initial) setLoad('loading');
    else setRefreshing(true);
    try {
      const ws = pickActiveWorkspace(await fetchMyWorkspaces());
      if (!ws) {
        setLoad('no-workspace');
        return;
      }
      const next = await getEmailHealth(ws.workspace_id);
      setReport(next);
      setError(null);
      setLoad('ready');
    } catch (err) {
      // Resilient by design: surface inline, never throw, never redirect.
      setError(messageOf(err, 'Could not load email health.'));
      setLoad('error');
    } finally {
      if (!initial) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!alive) return;
      await fetchReport(true);
    })();
    return () => {
      alive = false;
    };
  }, [fetchReport]);

  // The no-workspace case renders nothing (the page's own empty state covers it).
  if (load === 'no-workspace') return null;

  return (
    <Card padded>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-primary">Email health</h2>
          {report && (
            <Badge variant={OVERALL[report.status].tone} dot>
              {OVERALL[report.status].label}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {report && (
            <span className="font-mono text-[11px] text-muted">
              checked {relativeFrom(report.generated_at) ?? 'recently'}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={load === 'loading' || refreshing}
            onClick={() => void fetchReport(false)}
          >
            {refreshing ? 'Re-checking…' : 'Re-check'}
          </Button>
        </div>
      </div>

      {load === 'loading' ? (
        <div className="mt-4 space-y-3">
          <Skeleton h={14} w="55%" />
          <Skeleton h={14} w="40%" />
          <Skeleton h={36} />
        </div>
      ) : load === 'error' ? (
        <p className="mt-3 text-xs text-danger">{error ?? 'Could not load email health.'}</p>
      ) : report ? (
        <div className="mt-4 space-y-4">
          <SetupRow setup={report.setup} />
          <QueueRow queue={report.queue} />
          <Checks checks={report.checks} />
        </div>
      ) : null}
    </Card>
  );
}

/** The one-line setup posture: engine, default mailbox, mailbox & agent counts. */
function SetupRow({ setup }: { setup: EmailHealthReport['setup'] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <Stat
        label="Engine"
        value={setup.engine_configured ? 'configured' : 'not configured'}
        tone={setup.engine_configured ? 'ok' : 'warn'}
      />
      <Stat
        label="Default mailbox"
        value={setup.default_mailbox ?? 'none'}
        mono={!!setup.default_mailbox}
        tone={setup.default_mailbox ? 'plain' : 'warn'}
      />
      <Stat label="Mailboxes" value={String(setup.mailbox_count)} />
      <Stat label="Agents" value={String(setup.agent_count)} />
      <Stat label="Autonomous" value={String(setup.autonomous_agents)} />
    </div>
  );
}

/** The approval-queue health: pending, oldest age, recent failed sends. */
function QueueRow({ queue }: { queue: EmailHealthReport['queue'] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-token bg-surface-overlay px-3 py-2 text-xs">
      <Stat
        label="Pending approvals"
        value={String(queue.pending_approvals)}
        tone={queue.pending_approvals > 0 ? 'warn' : 'ok'}
      />
      <Stat label="Oldest pending" value={ageLabel(queue.oldest_pending_age_hours)} />
      <Stat
        label="Failed sends · 7d"
        value={String(queue.failed_sends_7d)}
        tone={queue.failed_sends_7d > 0 ? 'fail' : 'ok'}
      />
    </div>
  );
}

/** One labelled stat — calm, compact, colour only when it carries a signal. */
function Stat({
  label,
  value,
  mono,
  tone = 'plain',
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'plain' | 'ok' | 'warn' | 'fail';
}) {
  const valueTone =
    tone === 'ok'
      ? 'text-success'
      : tone === 'warn'
        ? 'text-warning'
        : tone === 'fail'
          ? 'text-danger'
          : 'text-secondary';
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-muted">{label}</span>
      <span className={cn('font-medium', mono && 'truncate font-mono', valueTone)}>{value}</span>
    </span>
  );
}

/** The individual signals, each a colored dot + label + detail. */
function Checks({ checks }: { checks: EmailHealthReport['checks'] }) {
  if (checks.length === 0) {
    return <p className="text-xs text-muted">No signals reported.</p>;
  }
  return (
    <ul className="space-y-2">
      {checks.map((check) => (
        <li key={check.key} className="flex items-start gap-2.5">
          <span
            aria-hidden
            className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', DOT[check.status])}
          />
          <div className="min-w-0">
            <span className="text-xs font-medium text-secondary">{check.label}</span>
            <span className="ml-2 text-xs text-tertiary">{check.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
