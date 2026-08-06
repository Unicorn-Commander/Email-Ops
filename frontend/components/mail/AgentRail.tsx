'use client';

/**
 * Zone 5: the right agent-activity rail.
 *
 * DEFAULT OPEN, toggled from the top bar (state persisted in localStorage via
 * railCollapsedStore). COLLAPSED it becomes a slim edge strip that still shows a
 * pending-approval count badge and a subtle pulse when approvals are waiting;
 * clicking it expands.
 *
 * Expanded it mirrors the design spec: a header with "Agent activity" + a Live
 * indicator, a 3-up metrics row (Triaged / Sent / Awaiting), the event feed
 * (timeline), and a footer autonomy dial (L0/L1/L2).
 *
 * All of it is REAL data reusing the existing data layer, and degrades clean:
 *   • the feed + Triaged/Sent metrics come from the agent-activity endpoint —
 *     if it 404/501s the feed shows a calm empty state (the rail still renders);
 *   • Awaiting = the live pending agent-inbox count (passed in);
 *   • the dial targets a real agent and writes through the agents autonomy PATCH
 *     — with no agents in the fleet the footer hides itself.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { agentLabel } from '@/lib/agents';
import { AgentChat } from './AgentChat';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import {
  getAgentActivity,
  getAgentMetrics,
  type AgentActionKind,
  type AgentActivityView,
  type AgentMetrics,
  type AgentView,
  type AutonomyLevel,
} from '@/lib/api';
import {
  RobotIcon,
  ClockIcon,
  SendIcon,
  CheckSquareIcon,
  BanIcon,
  SlidersIcon,
  GearIcon,
  ChevronLeftIcon,
} from './icons';

/** Two-letter monogram for a resolved actor name (drops Re:/kebab noise). */
function monogram(name: string): string {
  const parts = name.replace(/[-_]+/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.slice(0, 2) || '··').toUpperCase();
}

/**
 * Resolve a feed row's drafting agent to a display label. Prefer the registered
 * fleet (real display_name); fall back to the humanized provenance slug; and for
 * rows with no agent key (system / mailbox-provisioning / fleet-wide events) show
 * a calm "System" — never the literal "Unknown agent".
 */
function resolveActor(
  agentKey: string | null,
  fleet: Map<string, AgentView>,
): { name: string; system: boolean } {
  if (!agentKey) return { name: 'System', system: true };
  const a = fleet.get(agentKey);
  return { name: a?.display_name?.trim() || agentLabel(agentKey), system: false };
}

/** Compact "Nm ago" from an ISO timestamp (best-effort; mirrors AgentActivityFeed). */
function relativeFrom(iso: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

type EventTone = 'staged' | 'sent' | 'approved' | 'blocked' | 'neutral';

const KIND_META: Record<AgentActionKind, { tone: EventTone; verb: string }> = {
  STAGED_FOR_APPROVAL: { tone: 'staged', verb: 'staged a reply for approval' },
  AUTONOMOUS_SEND: { tone: 'sent', verb: 'sent a message autonomously' },
  APPROVED: { tone: 'approved', verb: 'approved & sent a draft' },
  REJECTED: { tone: 'blocked', verb: 'rejected a draft' },
  PAUSED: { tone: 'staged', verb: 'paused the fleet' },
  RESUMED: { tone: 'approved', verb: 'resumed the fleet' },
};

const TONE_ICON: Record<EventTone, { bg: string; fg: string; Glyph: (p: { className?: string }) => ReactNode }> = {
  staged: { bg: 'bg-warning/15', fg: 'text-warning', Glyph: ClockIcon },
  sent: { bg: 'bg-info/15', fg: 'text-info', Glyph: SendIcon },
  approved: { bg: 'bg-success/15', fg: 'text-success', Glyph: CheckSquareIcon },
  blocked: { bg: 'bg-danger/15', fg: 'text-danger', Glyph: BanIcon },
  neutral: { bg: 'bg-accent/15', fg: 'text-accent', Glyph: SlidersIcon },
};

const AUTONOMY_STEPS: { level: AutonomyLevel; short: string; label: string; hint: string }[] = [
  {
    level: 'L0_DRAFT_ONLY',
    short: 'L0',
    label: 'Draft only',
    hint: 'L0 — the agent only drafts; every send needs your approval.',
  },
  {
    level: 'L1_APPROVE_TO_SEND',
    short: 'L1',
    label: 'Approve to send',
    hint: 'L1 — sends internal mail on its own; anything external waits for your approval.',
  },
  {
    level: 'L2_AUTONOMOUS_AUDIT',
    short: 'L2',
    label: 'Autonomous',
    hint: 'L2 — also auto-sends routine external replies to trusted correspondents (no attachments, max 5 recipients, never first contact). Everything is audited in Auto-sent.',
  },
];

export function AgentRail({
  collapsed,
  onExpand,
  onCollapse,
  pendingCount,
  agents,
  agentsAvailable,
  selectedMailboxId,
  paused,
  onSetAutonomy,
  getChatContext,
}: {
  collapsed: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  pendingCount: number;
  agents: AgentView[];
  /** Whether the agents endpoint resolved (false → hide the dial regardless). */
  agentsAvailable: boolean;
  selectedMailboxId: string | null;
  paused: boolean;
  onSetAutonomy: (agentId: string, level: AutonomyLevel) => Promise<{ ok: boolean; error?: string }>;
  /** Light digest of the current view, evaluated at send time for the chat. */
  getChatContext?: () => Record<string, unknown>;
}) {
  const router = useRouter();
  const { activeWorkspace } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;

  const [mode, setMode] = useState<'chat' | 'activity'>('chat');
  const [activity, setActivity] = useState<AgentActivityView[]>([]);
  const [activityOk, setActivityOk] = useState<boolean>(true);
  const [loaded, setLoaded] = useState(false);
  // Real server-computed metrics (null until the first fetch settles / on error).
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setLoaded(true); // no workspace → calm empty state, not an endless skeleton
      return;
    }
    // Feed + metrics load together but degrade independently: a metrics hiccup
    // never blanks the feed (and vice-versa).
    const [activityRes, metricsRes] = await Promise.allSettled([
      getAgentActivity(workspaceId, 40),
      getAgentMetrics(workspaceId, '7d'),
    ]);
    if (activityRes.status === 'fulfilled') {
      setActivity(activityRes.value.items);
      setActivityOk(true);
    } else {
      // Endpoint absent / errored → degrade clean (empty feed, rail stays).
      setActivityOk(false);
    }
    // Metrics are best-effort chrome: on failure fall back to nothing (the tiles
    // then show the honest server default of 0 rather than an activity-count guess).
    setMetrics(metricsRes.status === 'fulfilled' ? metricsRes.value : null);
    setLoaded(true);
  }, [workspaceId]);

  useEffect(() => {
    setLoaded(false);
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener('agent-inbox:changed', onChanged);
    window.addEventListener('focus', onChanged);
    return () => {
      window.removeEventListener('agent-inbox:changed', onChanged);
      window.removeEventListener('focus', onChanged);
    };
  }, [refresh]);

  // Resolve feed rows against the live fleet so a drafting-agent key becomes a
  // real display name (never "Unknown agent").
  const fleetByKey = useMemo(() => new Map(agents.map((a) => [a.key, a])), [agents]);

  // Triaged/Sent are now REAL server-side counts over a 7d window (was a client
  // proxy of activity-feed volume). Awaiting stays the exact live pending queue.
  const triaged = metrics?.triaged ?? 0;
  const sent = metrics?.sent ?? 0;

  // The dial targets one agent: prefer the one bound to the open mailbox, else the
  // first active agent, else the first agent.
  const dialAgent = useMemo(() => {
    if (agents.length === 0) return null;
    if (selectedMailboxId) {
      const bound = agents.find(
        (a) =>
          a.mailbox_account_id === selectedMailboxId ||
          a.mailboxes?.some((m) => m.mailbox_account_id === selectedMailboxId),
      );
      if (bound) return bound;
    }
    return agents.find((a) => a.active) ?? agents[0];
  }, [agents, selectedMailboxId]);

  const [dialBusy, setDialBusy] = useState(false);
  const setLevel = useCallback(
    async (level: AutonomyLevel) => {
      if (!dialAgent || dialBusy || level === dialAgent.autonomy_level) return;
      setDialBusy(true);
      await onSetAutonomy(dialAgent.id, level);
      setDialBusy(false);
    },
    [dialAgent, dialBusy, onSetAutonomy],
  );

  // ── Collapsed: slim edge strip ────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside className="hidden h-full w-full flex-col items-center gap-3 border-l border-subtle bg-surface-raised py-3 lg:flex">
        <Tooltip content="Expand the agent rail — chat and the live activity timeline" side="left">
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand agent activity"
          className="relative grid h-8 w-8 place-items-center rounded-lg text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary"
        >
          <RobotIcon className="h-[18px] w-[18px]" />
          {pendingCount > 0 && (
            <span
              className={cn(
                'absolute -right-1 -top-1 grid h-[16px] min-w-[16px] place-items-center rounded-full bg-warning px-1 text-[9px] font-bold leading-none text-white eops-approval-pulse mono',
              )}
            >
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          )}
        </button>
        </Tooltip>
        <span
          className="mt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-tertiary [writing-mode:vertical-rl]"
          aria-hidden
        >
          Agent activity
        </span>
      </aside>
    );
  }

  // ── Expanded ──────────────────────────────────────────────────────────────
  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-subtle bg-surface-raised">
      <div className="border-b border-subtle px-4 pb-3 pt-3.5">
        <div className={cn('flex items-center gap-2', mode === 'activity' && 'mb-3')}>
          <div className="flex flex-1 items-center gap-0.5 rounded-lg bg-surface-overlay p-0.5">
            {(['chat', 'activity'] as const).map((m) => (
              <Tooltip
                key={m}
                content={
                  m === 'chat'
                    ? 'Ask your agents about the mail on screen'
                    : 'The live audit timeline of what agents staged, sent, and had approved'
                }
              >
                <button
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors',
                    mode === m
                      ? 'bg-surface-raised text-primary shadow-token'
                      : 'text-tertiary hover:text-secondary',
                  )}
                >
                  {m === 'chat' ? (
                    <RobotIcon className="h-[13px] w-[13px]" />
                  ) : (
                    <ClockIcon className="h-[13px] w-[13px]" />
                  )}
                  {m === 'chat' ? 'Chat' : 'Activity'}
                </button>
              </Tooltip>
            ))}
          </div>
          {mode === 'activity' &&
            (paused ? (
              <Tooltip content="The workspace kill switch is on — agents can't compose or send until resumed from the top bar">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.07em] text-warning/90">
                  <span className="h-[5px] w-[5px] rounded-full bg-warning" />
                  Paused
                </span>
              </Tooltip>
            ) : (
              <Tooltip content="Agents are active — this feed updates as they work">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.07em] text-tertiary">
                  <span className="h-[5px] w-[5px] rounded-full bg-success eops-live-pulse" />
                  Live
                </span>
              </Tooltip>
            ))}
          <Tooltip content="Collapse the agent rail">
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Collapse agent panel"
              className="grid h-6 w-6 place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary"
            >
              <ChevronLeftIcon className="h-[15px] w-[15px] rotate-180" />
            </button>
          </Tooltip>
        </div>
        {mode === 'activity' && (
          <div className="flex items-stretch rounded-[10px] border border-subtle bg-surface-base/40">
            <Stat
              n={triaged}
              label="Triaged"
              hint="Threads agents filed into folders in the last 7 days — your own triage isn't counted"
            />
            <span className="my-2.5 w-px bg-border-subtle" />
            <Stat
              n={sent}
              label="Sent"
              hint="Agent sends in the last 7 days — autonomous sends plus drafts you approved"
            />
            <span className="my-2.5 w-px bg-border-subtle" />
            <Stat
              n={pendingCount}
              label="Awaiting"
              warn
              hint="Drafts and cleanup batches waiting for your approval right now"
            />
          </div>
        )}
      </div>

      {mode === 'chat' ? (
        <AgentChat getContext={getChatContext} />
      ) : (
        <>
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {!loaded ? (
          <FeedSkeleton />
        ) : activity.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-[12px] font-medium text-secondary">
              {activityOk ? 'No agent activity yet' : 'Activity unavailable'}
            </p>
            <p className="mt-1 text-[11px] leading-5 text-tertiary">
              {activityOk
                ? 'When agents triage, draft, or send, it shows up here as a live timeline.'
                : 'The activity feed is not reachable right now. Approvals below still reflect the live queue.'}
            </p>
          </div>
        ) : (
          activity.map((ev, i) => (
            <EventRow
              key={ev.id}
              ev={ev}
              fleet={fleetByKey}
              last={i === activity.length - 1}
              onReview={() => router.push('/agent-inbox')}
            />
          ))
        )}
      </div>

      {agentsAvailable && dialAgent && (
        <div className="border-t border-subtle px-4 pb-3.5 pt-3">
          <div className="mb-2.5 flex items-center justify-between">
            <Tooltip content="How far this agent may go in the send path — open Help for the full matrix">
              <a
                href="/help#autonomy-trust"
                className="text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary hover:text-secondary hover:underline"
              >
                Autonomy
              </a>
            </Tooltip>
            <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-secondary">
              <i className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              {dialAgent.display_name || agentLabel(dialAgent.key)}
            </span>
          </div>
          <div className="flex gap-[3px] rounded-[9px] bg-surface-overlay p-[3px]">
            {AUTONOMY_STEPS.map((step) => {
              const on = dialAgent.autonomy_level === step.level;
              return (
                <Tooltip key={step.level} content={step.hint}>
                  <button
                    type="button"
                    disabled={dialBusy}
                    aria-pressed={on}
                    onClick={() => void setLevel(step.level)}
                    className={cn(
                      'flex-1 rounded-[7px] px-1 py-1.5 text-center text-[11px] font-semibold leading-tight transition-colors disabled:opacity-70',
                      on
                        ? 'bg-accent text-white shadow-[0_2px_6px_-1px_rgb(var(--accent)/0.5)]'
                        : 'text-tertiary hover:text-secondary',
                    )}
                  >
                    {step.short}
                    <small className="mt-px block text-[9px] font-medium opacity-70">{step.label}</small>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}
        </>
      )}
    </aside>
  );
}

function Stat({ n, label, warn, hint }: { n: number; label: string; warn?: boolean; hint?: string }) {
  return (
    <Tooltip content={hint} disabled={!hint}>
      <div className="flex-1 px-1 py-2 text-center" tabIndex={hint ? 0 : undefined}>
        <div
          className={cn(
            'text-[19px] font-bold leading-none tracking-[-0.02em] mono',
            warn && n > 0 ? 'text-warning' : 'text-primary',
          )}
        >
          {n}
        </div>
        <div className="mt-1.5 text-[9px] font-medium uppercase tracking-[0.09em] text-tertiary">
          {label}
        </div>
      </div>
    </Tooltip>
  );
}

function EventRow({
  ev,
  fleet,
  last,
  onReview,
}: {
  ev: AgentActivityView;
  fleet: Map<string, AgentView>;
  last: boolean;
  onReview: () => void;
}) {
  const meta = KIND_META[ev.kind] ?? { tone: 'neutral' as EventTone, verb: ev.kind.toLowerCase() };
  const tone = TONE_ICON[meta.tone];
  const when = relativeFrom(ev.created_at);
  const actor = resolveActor(ev.agent_key, fleet);
  return (
    <div className="relative grid grid-cols-[28px_1fr] gap-2.5 px-4 py-2.5">
      {!last && <span className="absolute left-[29px] top-[32px] bottom-[-10px] w-px bg-border-subtle" />}
      {actor.system ? (
        <span className="z-[1] grid h-[28px] w-[28px] place-items-center rounded-full bg-surface-overlay text-tertiary">
          <GearIcon className="h-[15px] w-[15px]" />
        </span>
      ) : (
        <span
          className={cn(
            'z-[1] grid h-[28px] w-[28px] place-items-center rounded-full text-[10px] font-bold mono',
            tone.bg,
            tone.fg,
          )}
          aria-hidden
        >
          {monogram(actor.name)}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-[12px] leading-[1.45] text-secondary">
          <b className="font-semibold text-primary">{actor.name}</b> {meta.verb}
          {ev.detail ? <span className="text-tertiary"> — {ev.detail}</span> : null}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted">
          {when && <span className="mono">{when}</span>}
          {when && <span className="text-border-strong">·</span>}
          <span className="rounded bg-surface-overlay px-1.5 py-px text-tertiary mono">
            {ev.kind.replace(/_/g, ' ').toLowerCase()}
          </span>
        </div>
        {ev.kind === 'STAGED_FOR_APPROVAL' && (
          <div className="mt-1.5">
            <button
              type="button"
              onClick={onReview}
              className="inline-flex h-[26px] items-center rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Review
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="space-y-3 px-4 py-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-2.5">
          <div className="h-[26px] w-[26px] shrink-0 animate-pulse rounded-[7px] bg-surface-overlay" />
          <div className="flex-1 space-y-1.5 py-0.5">
            <div className="h-2.5 w-4/5 animate-pulse rounded bg-surface-overlay" />
            <div className="h-2 w-2/5 animate-pulse rounded bg-surface-overlay" />
          </div>
        </div>
      ))}
    </div>
  );
}
