'use client';

/**
 * useAgentPulse — ambient data layer for the AiPulse strip.
 *
 * Wraps the two REAL agent-observability endpoints that already power the
 * agent rail (no invented routes):
 *   • GET /workspaces/:id/agent-activity  (getAgentActivity → audit feed)
 *   • GET /workspaces/:id/agent-metrics   (getAgentMetrics  → honest counters)
 *
 * Fetches on mount, refreshes every 60s, and re-probes on the same signals the
 * rest of the cockpit uses (`agent-inbox:changed` after an approve/reject, and
 * window focus). Degrade-clean by design: each endpoint fails independently, a
 * failure keeps the last-known values (never throws, never redirects — an
 * ambient surface must never hijack the page), and when the activity feed has
 * never resolved `recent` stays [] so AiPulse omits the block gracefully.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getAgentActivity,
  getAgentMetrics,
  type AgentActionKind,
  type AgentActivityView,
  type AgentMetrics,
} from '@/lib/api';
import { agentLabel } from '@/lib/agents';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import type { AiPulseActivityLine } from './AiPulse';

export interface AgentPulse {
  /**
   * Real server-side counters over the lookback window
   * ({ triaged, sent, awaiting, window_days }); null until resolved / on error.
   */
  metrics: AgentMetrics | null;
  /** Newest-first, AiPulse-ready lines (max `maxLines`); [] when unavailable. */
  recent: AiPulseActivityLine[];
  /** Whether the activity endpoint has ever resolved for this workspace. */
  activityAvailable: boolean;
  /** 'loading' until the first fetch settles (or no workspace resolves). */
  load: 'loading' | 'ready';
  /** Manual re-probe (both endpoints, silently). */
  refresh: () => Promise<void>;
}

/** Per-kind verb — mirrors the agent rail's KIND_META so the story reads the same. */
const VERB: Record<AgentActionKind, string> = {
  STAGED_FOR_APPROVAL: 'staged a reply for approval',
  AUTONOMOUS_SEND: 'sent a message autonomously',
  APPROVED: 'approved & sent a draft',
  REJECTED: 'rejected a draft',
  PAUSED: 'paused the fleet',
  RESUMED: 'resumed the fleet',
};

/** Compact "2h ago" from an ISO timestamp; '' when unknown (AiPulse hides it). */
function relativeFrom(iso: string | null): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One audit row → one strip line ("Customer-Ops staged a reply for approval"). */
function toLine(ev: AgentActivityView): AiPulseActivityLine {
  const actor = ev.agent_key ? agentLabel(ev.agent_key) : 'System';
  const verb = VERB[ev.kind] ?? String(ev.kind).replace(/_/g, ' ').toLowerCase();
  return { label: `${actor} ${verb}`, when: relativeFrom(ev.created_at) };
}

export function useAgentPulse(options?: {
  /** Audit rows to fetch (default 8 — enough to survive slicing). */
  activityLimit?: number;
  /** Lines exposed to the strip (default 3). */
  maxLines?: number;
  /** Metrics lookback like '7d' (default '7d', matching the rail). */
  metricsWindow?: string;
  /** Poll interval in ms (default 60_000). */
  refreshMs?: number;
}): AgentPulse {
  const activityLimit = options?.activityLimit ?? 8;
  const maxLines = options?.maxLines ?? 3;
  const metricsWindow = options?.metricsWindow ?? '7d';
  const refreshMs = options?.refreshMs ?? 60_000;

  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;

  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [recent, setRecent] = useState<AiPulseActivityLine[]>([]);
  const [activityAvailable, setActivityAvailable] = useState(false);
  const [load, setLoad] = useState<'loading' | 'ready'>('loading');

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    // Both endpoints load together but degrade independently — a metrics hiccup
    // never blanks the recent lines (and vice-versa). Failures keep last-known.
    const [activityRes, metricsRes] = await Promise.allSettled([
      getAgentActivity(workspaceId, activityLimit),
      getAgentMetrics(workspaceId, metricsWindow),
    ]);
    if (activityRes.status === 'fulfilled') {
      setRecent(activityRes.value.items.slice(0, maxLines).map(toLine));
      setActivityAvailable(true);
    }
    if (metricsRes.status === 'fulfilled') setMetrics(metricsRes.value);
    setLoad('ready');
  }, [workspaceId, activityLimit, maxLines, metricsWindow]);

  useEffect(() => {
    if (!workspaceId) {
      // Reset so a workspace switch never shows the previous org's pulse.
      setMetrics(null);
      setRecent([]);
      setActivityAvailable(false);
      setLoad(workspaceLoad === 'loading' ? 'loading' : 'ready');
      return;
    }
    setLoad('loading');
    void refresh();
    const timer = window.setInterval(() => void refresh(), refreshMs);
    const onChanged = () => void refresh();
    window.addEventListener('agent-inbox:changed', onChanged);
    window.addEventListener('focus', onChanged);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('agent-inbox:changed', onChanged);
      window.removeEventListener('focus', onChanged);
    };
  }, [workspaceId, workspaceLoad, refresh, refreshMs]);

  return { metrics, recent, activityAvailable, load, refresh };
}
