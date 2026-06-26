'use client';

/**
 * Agent Activity feed — the compact, newest-first audit timeline of the
 * governance-relevant things agents (and their human stewards) did with mail:
 * autonomous sends, drafts staged for approval, human approvals/rejections, and
 * the kill-switch (agents paused/resumed). It answers, at a glance, "what has the
 * fleet been doing, and who signed off?" for an operator.
 *
 * Self-contained like `EmailHealthPanel`: it resolves the active workspace and
 * fetches once on mount, is resilient by design (any failure → an inline
 * message, never throws), and never redirects (it must never hijack the page it
 * sits on). Calm Control: compact, low-chrome, no spinners beyond a skeleton.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Skeleton, cn } from '@/components/ui';
import {
  getAgentActivity,
  type AgentActionKind,
  type AgentActivityView,
} from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';

type Load = 'loading' | 'ready' | 'error' | 'no-workspace';

/** Per-kind human label + dot colour (the single source of truth). */
const KIND: Record<AgentActionKind, { label: string; dot: string }> = {
  AUTONOMOUS_SEND: { label: 'Autonomous send', dot: 'bg-info' },
  STAGED_FOR_APPROVAL: { label: 'Staged for approval', dot: 'bg-warning' },
  APPROVED: { label: 'Approved & sent', dot: 'bg-success' },
  REJECTED: { label: 'Rejected', dot: 'bg-danger' },
  PAUSED: { label: 'Agents paused', dot: 'bg-warning' },
  RESUMED: { label: 'Agents resumed', dot: 'bg-success' },
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

export function AgentActivityFeed() {
  // Consume the active org so the feed re-fetches when it switches.
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;
  const [items, setItems] = useState<AgentActivityView[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchActivity = useCallback(async (workspaceId: string, initial: boolean) => {
    if (initial) setLoad('loading');
    else setRefreshing(true);
    try {
      const next = await getAgentActivity(workspaceId, 50);
      setItems(next.items);
      setError(null);
      setLoad('ready');
    } catch (err) {
      // Resilient by design: surface inline, never throw, never redirect.
      setError(messageOf(err, 'Could not load agent activity.'));
      setLoad('error');
    } finally {
      if (!initial) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) {
      // Settle to no-workspace only once the org layer has resolved.
      if (workspaceLoad !== 'loading') setLoad('no-workspace');
      return;
    }
    void fetchActivity(activeWorkspaceId, true);
  }, [activeWorkspaceId, workspaceLoad, fetchActivity]);

  // The no-workspace case renders nothing (the page's own empty state covers it).
  if (load === 'no-workspace') return null;

  return (
    <Card padded>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-primary">Agent activity</h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={load === 'loading' || refreshing}
          onClick={() => {
            if (activeWorkspaceId) void fetchActivity(activeWorkspaceId, false);
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {load === 'loading' ? (
        <div className="mt-4 space-y-3">
          <Skeleton h={14} w="70%" />
          <Skeleton h={14} w="55%" />
          <Skeleton h={14} w="60%" />
        </div>
      ) : load === 'error' ? (
        <p className="mt-3 text-xs text-danger">{error ?? 'Could not load agent activity.'}</p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-xs text-muted">No agent activity yet.</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** One audit row: colored dot · kind label · agent chip · detail · relative time. */
function ActivityRow({ item }: { item: AgentActivityView }) {
  const kind = KIND[item.kind];
  const when = item.created_at ? relativeFrom(item.created_at) : null;
  return (
    <li className="flex items-start gap-2.5">
      <span
        aria-hidden
        className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', kind?.dot ?? 'bg-muted')}
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-xs font-medium text-secondary">
          {kind?.label ?? item.kind}
        </span>
        {item.agent_key && (
          <span className="shrink-0 rounded-token bg-surface-overlay px-1.5 py-0.5 font-mono text-[11px] text-tertiary">
            {item.agent_key}
          </span>
        )}
        {item.detail && <span className="truncate text-xs text-tertiary">{item.detail}</span>}
      </div>
      {when && (
        <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted">{when}</span>
      )}
    </li>
  );
}
