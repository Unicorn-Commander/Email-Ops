'use client';

/**
 * AiPulse — the "AI at work" strip for the daily brief.
 *
 * One compact, violet-tinted band that answers "how is the AI helping me right
 * now" with real numbers the page already holds: agents live, drafts awaiting
 * review, cleanup batches staged, rules active — plus up to three recent
 * activity lines when the caller provides them (from the real agent-activity
 * feed via `useAgentPulse`; omit the prop and the block disappears cleanly).
 *
 * Deliberately distinct from the BriefStat tiles: those are the day's mailbox
 * counts; this strip is specifically the AGENT layer, on the house violet
 * signal. Purely presentational, every number truthful — chips render only what
 * they are given (no placeholders, no fake activity), and the Live indicator
 * mirrors the agent rail's language (success pulse live, warning when paused).
 */

import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import { ClockIcon, RobotIcon, TrashIcon } from './icons';

/** One pre-formatted recent-activity line ("Customer-Ops staged a reply…" · "2h ago"). */
export interface AiPulseActivityLine {
  label: string;
  when: string;
}

export interface AiPulseProps {
  /** Active, un-paused agents (null = fleet endpoint not resolved → chip hidden). */
  agentsLive: number | null;
  /** Pending EMAIL-kind approvals (proposed replies). */
  pendingDrafts: number;
  /** Pending CLEANUP-kind approvals (staged batches). Chip shows only when > 0. */
  pendingCleanups: number;
  /** Enabled mail rules (null/undefined = unknown → chip hidden). */
  rulesActive?: number | null;
  /** Up to 3 recent lines from the real activity feed; omit to hide the block. */
  lastAgentActivity?: AiPulseActivityLine[];
  /** Workspace kill-switch state — shown honestly instead of a false "Live". */
  paused?: boolean;
  className?: string;
}

/** Funnel glyph for the rules chip (icons.tsx has none; same stroke language). */
function FunnelGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z" />
    </svg>
  );
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** One stat chip: icon · count (tabular) · label. Warn tone when work waits. */
function PulseChip({
  icon,
  n,
  label,
  warn,
}: {
  icon: ReactNode;
  n: number;
  label: string;
  warn?: boolean;
}) {
  const hot = warn && n > 0;
  return (
    <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-subtle bg-surface-base/60 pl-2 pr-2.5 text-[11px] font-medium text-secondary">
      <span className={cn('shrink-0', hot ? 'text-warning' : 'text-accent')} aria-hidden>
        {icon}
      </span>
      <b className={cn('font-bold mono', hot ? 'text-warning' : 'text-primary')}>{n}</b>
      {label}
    </span>
  );
}

export function AiPulse({
  agentsLive,
  pendingDrafts,
  pendingCleanups,
  rulesActive,
  lastAgentActivity,
  paused = false,
  className,
}: AiPulseProps) {
  const recent = (lastAgentActivity ?? []).slice(0, 3);
  const live = !paused && (agentsLive ?? 0) > 0;

  return (
    <section
      aria-label="AI at work"
      className={cn(
        'overflow-hidden rounded-token-lg border border-accent/20 bg-gradient-to-br from-accent/[0.07] via-accent/[0.02] to-transparent',
        className,
      )}
    >
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <span
          className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md bg-accent text-white"
          aria-hidden
        >
          <RobotIcon className="h-[13px] w-[13px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight text-primary">AI at work</p>
          <p className="mt-0.5 text-[11px] leading-tight text-tertiary">
            {paused
              ? 'Agents are paused — nothing runs until you resume them.'
              : 'What your agents are handling in this workspace.'}
          </p>
        </div>
        {paused ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.07em] text-warning/90">
            <span className="h-[5px] w-[5px] rounded-full bg-warning" aria-hidden />
            Paused
          </span>
        ) : live ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.07em] text-tertiary">
            <span className="h-[5px] w-[5px] rounded-full bg-success eops-live-pulse" aria-hidden />
            Live
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3.5 pt-2.5">
        {agentsLive != null && (
          <PulseChip
            icon={<RobotIcon className="h-3 w-3" />}
            n={agentsLive}
            label={plural(agentsLive, 'agent live', 'agents live')}
          />
        )}
        <PulseChip
          icon={<ClockIcon className="h-3 w-3" />}
          n={pendingDrafts}
          label={plural(pendingDrafts, 'draft awaits review', 'drafts await review')}
          warn
        />
        {pendingCleanups > 0 && (
          <PulseChip
            icon={<TrashIcon className="h-3 w-3" />}
            n={pendingCleanups}
            label={plural(pendingCleanups, 'cleanup staged', 'cleanups staged')}
            warn
          />
        )}
        {typeof rulesActive === 'number' && (
          <PulseChip
            icon={<FunnelGlyph className="h-3 w-3" />}
            n={rulesActive}
            label={plural(rulesActive, 'rule active', 'rules active')}
          />
        )}
      </div>

      {recent.length > 0 && (
        <ul
          aria-label="Recent agent activity"
          className="space-y-1.5 border-t border-accent/15 px-4 py-2.5"
        >
          {recent.map((line, i) => (
            <li key={`${i}-${line.label}`} className="flex items-baseline gap-2 text-[11px]">
              <span className="h-1 w-1 shrink-0 self-center rounded-full bg-accent/70" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-secondary">{line.label}</span>
              {line.when && <span className="shrink-0 text-muted mono">{line.when}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
