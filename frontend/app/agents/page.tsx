'use client';

/**
 * Agents — the per-workspace agent fleet registry.
 *
 * The second pillar of the Agent Email Command Center (the first is the
 * approval queue at /agent-inbox): each agent is a first-class identity that
 * drafts/sends mail from an assigned mailbox under an autonomy level. This view
 * lets a human SEE and MANAGE the fleet — list agents, see each one's sending
 * mailbox + autonomy + how many drafts await approval, create a new agent, and
 * edit (mailbox, autonomy, active).
 *
 * The autonomy level is the policy you set per agent; ENFORCEMENT in the send
 * path is a follow-up — so L2 does not auto-send today.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Input,
  Select,
  Skeleton,
  SkeletonText,
  useConfirm,
  type BadgeVariant,
} from '@/components/ui';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgents } from '@/components/useAgents';
import { useActiveSpace } from '@/components/ActiveSpaceProvider';
import { EmailHealthPanel } from '@/components/EmailHealthPanel';
import { AgentActivityFeed } from '@/components/AgentActivityFeed';
import { agentLabel } from '@/lib/agents';
import {
  ApiError,
  bindAgentMailbox,
  getAgentMailbox,
  listAgentMailboxes,
  listMailboxes,
  unbindAgentMailbox,
  type AgentMailboxView,
  type AgentMailboxViewResponse,
  type AgentTier,
  type AgentView,
  type AutonomyLevel,
  type MailboxAccess,
  type MailboxListItem,
} from '@/lib/api';

/** Human copy + badge tone for each autonomy level (single source of truth). */
const AUTONOMY: Record<
  AutonomyLevel,
  { label: string; desc: string; tone: BadgeVariant }
> = {
  L0_DRAFT_ONLY: {
    label: 'Draft only',
    desc: 'Stages drafts; never sends, even autonomously.',
    tone: 'neutral',
  },
  // Wave 7 semantics: "first contact needs a human; ongoing conversation flows."
  L1_APPROVE_TO_SEND: {
    label: 'Approve to send',
    desc: 'Sends internal mail on its own; anything external waits for your approval.',
    tone: 'info',
  },
  L2_AUTONOMOUS_AUDIT: {
    label: 'Autonomous',
    desc: 'Also sends routine external replies to correspondents you have approved once; first contact, attachments, and cold outreach still wait for you. Every send is audited.',
    tone: 'warning',
  },
};

const AUTONOMY_ORDER: AutonomyLevel[] = [
  'L0_DRAFT_ONLY',
  'L1_APPROVE_TO_SEND',
  'L2_AUTONOMOUS_AUDIT',
];
const DEFAULT_AUTONOMY: AutonomyLevel = 'L1_APPROVE_TO_SEND';

/** Human copy + badge tone for each hierarchy tier (UNSPECIFIED renders nothing). */
const TIER: Record<Exclude<AgentTier, 'UNSPECIFIED'>, { label: string; tone: BadgeVariant }> = {
  EXECUTIVE: { label: 'Executive', tone: 'accent' },
  DOMAIN_LEAD: { label: 'Domain lead', tone: 'protected' },
  MANAGER: { label: 'Manager', tone: 'info' },
  SPECIALIST: { label: 'Specialist', tone: 'neutral' },
};

/** Access options for a bound mailbox, in picker order. */
const ACCESS_ORDER: MailboxAccess[] = ['BOTH', 'SEND', 'READ'];
const ACCESS_LABEL: Record<MailboxAccess, string> = {
  BOTH: 'Read + send',
  SEND: 'Send only',
  READ: 'Read only',
};
const DEFAULT_ACCESS: MailboxAccess = 'BOTH';

export default function AgentsPage() {
  const { workspace, items, load, error, refresh, create, update } = useAgents();
  const { activeSpace } = useActiveSpace();
  const [createOpen, setCreateOpen] = useState(false);

  // Live per-agent unread from the mailbox roster (best-effort — if it fails the
  // cards simply omit the unread badge). Re-fetched when the fleet refreshes.
  const workspaceId = workspace?.workspace_id ?? null;
  const [unreadByAgent, setUnreadByAgent] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    listAgentMailboxes(workspaceId)
      .then((res) => {
        if (alive) setUnreadByAgent(new Map(res.items.map((i) => [i.agent.id, i.mailbox.unread])));
      })
      .catch(() => {
        /* best-effort; the card omits the badge */
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, items]);

  // Scope the displayed fleet to the active Space (purely client-side). "All" —
  // a null activeSpace — is unfiltered.
  const visibleItems = useMemo(() => {
    if (!activeSpace) return items;
    const allowed = new Set(activeSpace.agent_ids);
    return items.filter((a) => allowed.has(a.id));
  }, [items, activeSpace]);

  const activeCount = useMemo(() => visibleItems.filter((a) => a.active).length, [visibleItems]);

  // Resolve each agent's manager_agent_key → its manager's display name, so a
  // card can show "reports to …" instead of the raw slug.
  const managerLabels = useMemo(() => {
    const byKey = new Map(items.map((a) => [a.key, a]));
    const out = new Map<string, string>();
    for (const agent of items) {
      if (!agent.manager_agent_key) continue;
      const manager = byKey.get(agent.manager_agent_key);
      out.set(agent.id, manager?.display_name || agentLabel(agent.manager_agent_key));
    }
    return out;
  }, [items]);

  return (
    <div className="space-y-7">
      <Hero
        total={visibleItems.length}
        active={activeCount}
        loading={load === 'loading'}
        onRefresh={() => void refresh()}
        onNew={() => setCreateOpen(true)}
        disableNew={load !== 'ready' || !workspace}
      />

      <EmailHealthPanel />

      {!workspace && load === 'ready' ? (
        <NoWorkspace />
      ) : load === 'loading' ? (
        <FleetSkeleton />
      ) : load === 'error' ? (
        <ErrorState message={error} onRetry={() => void refresh()} />
      ) : visibleItems.length === 0 ? (
        activeSpace && items.length > 0 ? (
          <NoSpaceAgents spaceName={activeSpace.name} />
        ) : (
          <EmptyState onNew={() => setCreateOpen(true)} />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PolicyNote />
            <span className="font-mono text-xs text-muted">
              {visibleItems.length} {visibleItems.length === 1 ? 'agent' : 'agents'}
            </span>
          </div>
          <div className="space-y-3">
            {visibleItems.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                managedByLabel={managerLabels.get(agent.id) ?? null}
                workspaceId={workspaceId}
                unread={unreadByAgent.get(agent.id) ?? 0}
                onUpdate={(body) => update(agent.id, body)}
                onRefresh={() => void refresh()}
              />
            ))}
          </div>
        </>
      )}

      <CreateAgentDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreate={create} />

      <AgentActivityFeed />
    </div>
  );
}

function Hero({
  total,
  active,
  loading,
  onRefresh,
  onNew,
  disableNew,
}: {
  total: number;
  active: number;
  loading: boolean;
  onRefresh: () => void;
  onNew: () => void;
  disableNew: boolean;
}) {
  return (
    <header className="relative overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_0%,rgb(var(--accent-2)/0.20),transparent_55%),radial-gradient(95%_130%_at_0%_100%,rgb(var(--accent)/0.18),transparent_55%),radial-gradient(80%_90%_at_50%_120%,rgb(var(--info)/0.12),transparent_60%)]" />
      <div className="relative p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={total > 0 ? 'info' : 'neutral'} dot>
                {total > 0 ? `${active} of ${total} active` : 'no agents yet'}
              </Badge>
              <Badge variant="protected">fleet &amp; autonomy</Badge>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
              Your agent fleet.{' '}
              <span className="bg-gradient-to-br from-accent via-[rgb(var(--accent-2))] to-info bg-clip-text text-transparent">
                You set the rules.
              </span>
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
              Each agent sends from an assigned mailbox under an autonomy level you choose. Manage
              who drafts, who needs your approval, and who is paused.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row lg:items-center">
            <Button variant="secondary" onClick={onRefresh} disabled={loading}>
              Refresh
            </Button>
            <Button onClick={onNew} disabled={disableNew}>
              New agent
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

/** The one-line summary of the LIVE autonomy enforcement (Wave 7 matrix). */
function PolicyNote() {
  return (
    <p className="max-w-2xl text-[11px] leading-5 text-muted">
      Autonomy is enforced in the send path: from their own mailboxes, L1+ agents send internal mail
      autonomously, and L2 agents also send routine external replies to correspondents you have
      approved once. First contact, attachments, and cold outreach always wait in{' '}
      <a href="/agent-inbox" className="underline decoration-dotted underline-offset-2">
        Approvals
      </a>
      {' — '}
      <a href="/help#autonomy-trust" className="underline decoration-dotted underline-offset-2">
        how it works
      </a>
      .
    </p>
  );
}

function AgentCard({
  agent,
  managedByLabel,
  workspaceId,
  unread,
  onUpdate,
  onRefresh,
}: {
  agent: AgentView;
  /** Resolved display name of this agent's manager (null = none). */
  managedByLabel: string | null;
  /** The active workspace id mailbox bindings are scoped to (null = none). */
  workspaceId: string | null;
  /** Live unread count in this agent's mailbox (0 = none / unknown). */
  unread: number;
  onUpdate: (body: { autonomy_level?: AutonomyLevel; active?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  /** Re-fetch the fleet after a mailbox binding changes. */
  onRefresh: () => void;
}) {
  const confirm = useConfirm();
  const autonomy = AUTONOMY[agent.autonomy_level];
  const tier = agent.tier !== 'UNSPECIFIED' ? TIER[agent.tier] : null;
  const [busy, setBusy] = useState<null | 'autonomy' | 'active'>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const [mailboxOpen, setMailboxOpen] = useState(false);

  async function handleAutonomy(next: AutonomyLevel) {
    if (next === agent.autonomy_level) return;
    setBusy('autonomy');
    setCardError(null);
    const res = await onUpdate({ autonomy_level: next });
    if (!res.ok) setCardError(res.error ?? 'Could not change autonomy.');
    setBusy(null);
  }

  async function handleToggleActive() {
    if (agent.active) {
      const ok = await confirm({
        title: `Deactivate ${agent.display_name}?`,
        description:
          'A deactivated agent stops drafting and is parked. Its records are kept; you can reactivate it any time.',
        confirmLabel: 'Deactivate',
        cancelLabel: 'Keep active',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy('active');
    setCardError(null);
    const res = await onUpdate({ active: !agent.active });
    if (!res.ok) setCardError(res.error ?? 'Could not update the agent.');
    setBusy(null);
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <AgentAvatar
            agentKey={agent.key}
            avatarUrl={agent.avatar_url}
            size={40}
            className="mt-0.5 ring-1 ring-border"
          />
          <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-primary">
              {agent.display_name || agentLabel(agent.key)}
            </span>
            <span className="rounded-token bg-surface-overlay px-1.5 py-0.5 font-mono text-[11px] text-tertiary">
              {agent.key}
            </span>
            <Badge variant={agent.active ? 'success' : 'neutral'} dot>
              {agent.active ? 'active' : 'inactive'}
            </Badge>
            {tier && <Badge variant={tier.tone}>{tier.label}</Badge>}
            <Badge variant={autonomy.tone}>{autonomy.label}</Badge>
            {agent.paused && (
              <Badge variant="warning" title="This agent is individually paused.">
                paused
              </Badge>
            )}
            {agent.pending_count > 0 && (
              <Link href="/agent-inbox" title="Review this agent's pending drafts">
                <Badge variant="review" className="transition hover:brightness-110">
                  {agent.pending_count} awaiting
                </Badge>
              </Link>
            )}
            {unread > 0 && (
              <Badge variant="info" title="Unread in this agent's mailbox">
                {unread} unread
              </Badge>
            )}
          </div>

          {agent.description && (
            <p className="mt-2 max-h-12 overflow-hidden text-xs leading-5 text-secondary">
              {agent.description}
            </p>
          )}

          {managedByLabel && (
            <p className="mt-2 text-[11px] leading-5 text-muted">
              reports to <span className="text-secondary">{managedByLabel}</span>
            </p>
          )}

          <p className="mt-1 text-[11px] leading-5 text-muted">{autonomy.desc}</p>

          <AgentMailboxes agent={agent} workspaceId={workspaceId} onRefresh={onRefresh} />

          {cardError && <p className="mt-3 text-xs text-danger">{cardError}</p>}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:w-[200px]">
          <label className="block" title={`${autonomy.label} — ${autonomy.desc}`}>
            <span className="mb-1 block text-[11px] font-medium text-tertiary">Autonomy</span>
            <Select
              aria-label={`Autonomy for ${agent.display_name}`}
              value={agent.autonomy_level}
              disabled={busy !== null}
              onChange={(event) => void handleAutonomy(event.target.value as AutonomyLevel)}
              className="bg-surface-raised text-xs"
            >
              {AUTONOMY_ORDER.map((level) => (
                <option key={level} value={level}>
                  {AUTONOMY[level].label}
                </option>
              ))}
            </Select>
          </label>
          <Button
            variant={agent.active ? 'secondary' : 'primary'}
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleToggleActive()}
          >
            {busy === 'active'
              ? agent.active
                ? 'Deactivating…'
                : 'Activating…'
              : agent.active
                ? 'Deactivate'
                : 'Activate'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!workspaceId}
            onClick={() => setMailboxOpen(true)}
            title={`See ${agent.display_name || agent.key}'s inbox and pending drafts`}
          >
            View mailbox
          </Button>
        </div>
      </div>

      {workspaceId && (
        <AgentMailboxDialog
          open={mailboxOpen}
          onClose={() => setMailboxOpen(false)}
          workspaceId={workspaceId}
          agentId={agent.id}
          agentName={agent.display_name || agentLabel(agent.key)}
        />
      )}
    </Card>
  );
}

/** Relative-time stamp for the agent-mailbox drill-in (terse, suite copy). */
function whenLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A complete relative-activity phrase (whenLabel + the right connective), so the
 *  caller never has to append " ago" — which mis-reads on "just now" / absolute dates. */
function lastActivityLabel(iso: string | null | undefined): string | null {
  const rel = whenLabel(iso);
  if (!rel) return null;
  if (rel === 'just now') return 'just now';
  return /^\d+[mhd]$/.test(rel) ? `${rel} ago` : `on ${rel}`;
}

function participantLabel(parts: { address: string; name: string | null }[]): string {
  if (parts.length === 0) return 'no participants';
  const first = parts[0];
  const head = first.name?.trim() || first.address;
  return parts.length > 1 ? `${head} +${parts.length - 1}` : head;
}

/**
 * Read-only drill-in into one agent's mailbox world (Fleet B): live stats, recent
 * threads, and its slice of the approval queue. Fetches on open; the reader /
 * compose live in /mail and /agent-inbox, linked from here.
 */
function AgentMailboxDialog({
  open,
  onClose,
  workspaceId,
  agentId,
  agentName,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  agentId: string;
  agentName: string;
}) {
  const [view, setView] = useState<AgentMailboxViewResponse | null>(null);
  const [load, setLoad] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoad('loading');
    setError(null);
    getAgentMailbox(workspaceId, agentId, 20)
      .then((res) => {
        if (!alive) return;
        setView(res);
        setLoad('ready');
      })
      .catch((err) => {
        if (!alive) return;
        setError(errText(err, 'Could not load this agent’s mailbox.'));
        setLoad('error');
      });
    return () => {
      alive = false;
    };
  }, [open, workspaceId, agentId]);

  const address = view?.agent.mailbox?.address ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`${agentName}’s mailbox`}
      description={address ? address : 'No sending mailbox assigned yet.'}
      footer={
        <Button variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      }
    >
      {load === 'loading' ? (
        <div className="space-y-3">
          <Skeleton h={44} />
          <SkeletonText lines={4} />
        </div>
      ) : load === 'error' ? (
        <p className="text-sm text-danger">{error}</p>
      ) : view ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Unread" value={view.stats.unread ?? 0} />
            <Stat label="Total" value={view.stats.total ?? 0} />
            <Stat
              label="Pending"
              value={view.agentInbox.counts.pending}
              tone={view.agentInbox.counts.pending > 0 ? 'review' : 'neutral'}
            />
          </div>
          {lastActivityLabel(view.stats.lastActivityAt) && (
            <p className="text-[11px] text-muted">
              Last activity {lastActivityLabel(view.stats.lastActivityAt)}
            </p>
          )}

          {view.agentInbox.pending.length > 0 && (
            <section>
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
                  Awaiting your approval
                </h3>
                <Link href="/agent-inbox" className="text-[11px] text-accent hover:underline">
                  Review all →
                </Link>
              </div>
              <ul className="space-y-1.5">
                {view.agentInbox.pending.slice(0, 5).map((item) => (
                  <li
                    key={item.id}
                    className="rounded-token border border-subtle bg-surface-raised px-2.5 py-1.5"
                  >
                    <p className="truncate text-xs font-medium text-primary">
                      {item.subject?.trim() || '(no subject)'}
                    </p>
                    <p className="truncate text-[11px] text-tertiary">
                      to {item.to_address ?? 'unknown'}
                      {item.body_preview ? ` — ${item.body_preview}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
              Recent threads
            </h3>
            {view.threads.length === 0 ? (
              <p className="text-[11px] leading-5 text-muted">
                {address
                  ? 'No mail in this mailbox yet.'
                  : 'Assign a mailbox to this agent to see its mail here.'}
              </p>
            ) : (
              <ul className="space-y-1">
                {view.threads.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center gap-2 rounded-token px-2.5 py-1.5"
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        t.unread ? 'bg-accent' : 'bg-transparent'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-xs ${
                          t.unread ? 'font-semibold text-primary' : 'text-secondary'
                        }`}
                      >
                        {t.unread && <span className="sr-only">Unread — </span>}
                        {t.subject?.trim() || '(no subject)'}
                      </span>
                      <span className="block truncate text-[11px] text-tertiary">
                        {participantLabel(t.participants)}
                        {t.last_snippet ? ` — ${t.last_snippet}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted">
                      {whenLabel(t.last_message_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </Dialog>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'review';
}) {
  return (
    <div className="rounded-token border border-subtle bg-surface-raised px-2.5 py-2 text-center">
      <div
        className={`text-lg font-semibold tabular-nums ${
          tone === 'review' ? 'text-accent' : 'text-primary'
        }`}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-tertiary">{label}</div>
    </div>
  );
}

/** Best-effort message off a thrown error (ApiError carries the backend text). */
function errText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/**
 * The per-agent Mailboxes section: lists every bound mailbox (address + access
 * + a Primary badge), lets an admin set-primary / remove each one, and add a new
 * binding from the workspace's mailboxes. All bind/unbind calls are ADMIN-gated
 * server-side — a 403 surfaces inline. Refreshes the fleet on every change.
 */
function AgentMailboxes({
  agent,
  workspaceId,
  onRefresh,
}: {
  agent: AgentView;
  workspaceId: string | null;
  onRefresh: () => void;
}) {
  const confirm = useConfirm();
  const mailboxes = agent.mailboxes ?? [];

  // Adder state.
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<MailboxListItem[] | null>(null);
  const [loadingChoices, setLoadingChoices] = useState(false);
  const [pick, setPick] = useState('');
  const [access, setAccess] = useState<MailboxAccess>(DEFAULT_ACCESS);

  // One "busy" marker per row action + the adder, plus a shared error line.
  const [busy, setBusy] = useState<string | null>(null); // 'add' | `primary:<id>` | `remove:<id>`
  const [mbError, setMbError] = useState<string | null>(null);

  const boundIds = useMemo(
    () => new Set(mailboxes.map((m) => m.mailbox_account_id)),
    [mailboxes],
  );

  // Mailboxes in the workspace not already bound to this agent.
  const available = useMemo(
    () => (choices ?? []).filter((m) => !boundIds.has(m.id)),
    [choices, boundIds],
  );

  const loadChoices = useCallback(async () => {
    if (!workspaceId) return;
    setLoadingChoices(true);
    setMbError(null);
    try {
      const res = await listMailboxes(workspaceId);
      setChoices(res.items);
    } catch (err) {
      setMbError(errText(err, 'Could not load the workspace mailboxes.'));
    } finally {
      setLoadingChoices(false);
    }
  }, [workspaceId]);

  // Load the pickable mailboxes the first time the adder opens.
  useEffect(() => {
    if (open && choices === null && !loadingChoices) void loadChoices();
  }, [open, choices, loadingChoices, loadChoices]);

  // Keep the selected pick valid as the available set changes.
  useEffect(() => {
    if (pick && !available.some((m) => m.id === pick)) setPick('');
  }, [available, pick]);

  async function handleAdd() {
    if (!workspaceId || !pick) return;
    setBusy('add');
    setMbError(null);
    try {
      await bindAgentMailbox(workspaceId, agent.id, {
        mailbox_account_id: pick,
        access,
        // First mailbox bound becomes primary; otherwise leave the existing primary.
        ...(mailboxes.length === 0 ? { is_primary: true } : {}),
      });
      setPick('');
      setAccess(DEFAULT_ACCESS);
      setOpen(false);
      setChoices(null); // re-list next open so the just-bound one drops out
      onRefresh();
    } catch (err) {
      setMbError(errText(err, 'Could not add the mailbox.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleSetPrimary(mb: AgentMailboxView) {
    if (!workspaceId || mb.is_primary) return;
    const ok = await confirm({
      title: 'Make this the primary mailbox?',
      description: (
        <>
          <span className="font-mono">{mb.mailbox_address ?? mb.mailbox_account_id}</span> becomes the
          mailbox {agent.display_name || agentLabel(agent.key)} sends from by default.
        </>
      ),
      confirmLabel: 'Set primary',
      cancelLabel: 'Cancel',
    });
    if (!ok) return;
    setBusy(`primary:${mb.mailbox_account_id}`);
    setMbError(null);
    try {
      await bindAgentMailbox(workspaceId, agent.id, {
        mailbox_account_id: mb.mailbox_account_id,
        is_primary: true,
      });
      onRefresh();
    } catch (err) {
      setMbError(errText(err, 'Could not set the primary mailbox.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(mb: AgentMailboxView) {
    if (!workspaceId) return;
    const ok = await confirm({
      title: 'Remove this mailbox?',
      description: (
        <>
          {agent.display_name || agentLabel(agent.key)} will no longer act on{' '}
          <span className="font-mono">{mb.mailbox_address ?? mb.mailbox_account_id}</span>.
        </>
      ),
      confirmLabel: 'Remove',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setBusy(`remove:${mb.mailbox_account_id}`);
    setMbError(null);
    try {
      await unbindAgentMailbox(workspaceId, agent.id, mb.mailbox_account_id);
      setChoices(null); // it's bindable again
      onRefresh();
    } catch (err) {
      setMbError(errText(err, 'Could not remove the mailbox.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 rounded-token border border-subtle bg-surface-base/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
          Mailboxes
        </span>
        {!open && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!workspaceId}
            onClick={() => setOpen(true)}
          >
            Add mailbox
          </Button>
        )}
      </div>

      {mailboxes.length === 0 ? (
        <p className="mt-2 text-[11px] leading-5 text-muted">
          No mailboxes assigned — this agent can’t send until you add one.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {mailboxes.map((mb) => {
            const removing = busy === `remove:${mb.mailbox_account_id}`;
            const settingPrimary = busy === `primary:${mb.mailbox_account_id}`;
            const rowBusy = busy !== null;
            return (
              <li
                key={mb.mailbox_account_id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-token bg-surface-raised px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">
                  {mb.mailbox_address ?? mb.mailbox_account_id}
                </span>
                <Badge variant="neutral">{ACCESS_LABEL[mb.access]}</Badge>
                {mb.is_primary && <Badge variant="info">Primary</Badge>}
                {!mb.is_primary && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={rowBusy}
                    onClick={() => void handleSetPrimary(mb)}
                  >
                    {settingPrimary ? 'Setting…' : 'Set primary'}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={rowBusy}
                  onClick={() => void handleRemove(mb)}
                  className="text-danger hover:text-danger"
                >
                  {removing ? 'Removing…' : 'Remove'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <div className="mt-3 space-y-2 rounded-token border border-subtle bg-surface-raised p-2.5">
          {loadingChoices ? (
            <p className="text-[11px] text-muted">Loading mailboxes…</p>
          ) : available.length === 0 ? (
            <p className="text-[11px] text-muted">
              No more workspace mailboxes to add.
            </p>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-[11px] font-medium text-tertiary">Mailbox</span>
                <Select
                  aria-label="Mailbox to bind"
                  value={pick}
                  disabled={busy !== null}
                  onChange={(event) => setPick(event.target.value)}
                  className="text-xs"
                >
                  <option value="">Select a mailbox…</option>
                  {available.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.email_address}
                      {m.display_name ? ` (${m.display_name})` : ''}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="block sm:w-[150px]">
                <span className="mb-1 block text-[11px] font-medium text-tertiary">Access</span>
                <Select
                  aria-label="Mailbox access"
                  value={access}
                  disabled={busy !== null}
                  onChange={(event) => setAccess(event.target.value as MailboxAccess)}
                  className="text-xs"
                >
                  {ACCESS_ORDER.map((a) => (
                    <option key={a} value={a}>
                      {ACCESS_LABEL[a]}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setOpen(false);
                setPick('');
                setMbError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busy !== null || !pick || loadingChoices}
              onClick={() => void handleAdd()}
            >
              {busy === 'add' ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {mbError && <p className="mt-2 text-xs text-danger">{mbError}</p>}
    </div>
  );
}

function CreateAgentDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (body: {
    key: string;
    display_name: string;
    description?: string;
    mailbox_account_id?: string;
    autonomy_level?: AutonomyLevel;
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [key, setKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(DEFAULT_AUTONOMY);
  const [mailboxId, setMailboxId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function reset() {
    setKey('');
    setDisplayName('');
    setDescription('');
    setAutonomy(DEFAULT_AUTONOMY);
    setMailboxId('');
    setFormError(null);
    setSubmitting(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next && !submitting) {
      reset();
      onClose();
    }
  }

  async function handleSubmit() {
    const trimmedKey = key.trim();
    const trimmedName = displayName.trim();
    if (!trimmedKey) {
      setFormError('A key (slug) is required.');
      return;
    }
    if (!trimmedName) {
      setFormError('A display name is required.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const res = await onCreate({
      key: trimmedKey,
      display_name: trimmedName,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(mailboxId.trim() ? { mailbox_account_id: mailboxId.trim() } : {}),
      autonomy_level: autonomy,
    });
    if (res.ok) {
      reset();
      onClose();
    } else {
      setFormError(res.error ?? 'Could not create the agent.');
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="New agent"
      description="Give it a stable key, a name, and the policy it operates under."
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting ? 'Creating…' : 'Create agent'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <Field label="Key (slug)" hint="Lowercase, stable, unique in this workspace — e.g. customer-ops.">
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="customer-ops"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Display name">
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Customer-Ops"
            autoComplete="off"
          />
        </Field>
        <Field label="Description" hint="Optional — what this agent is for.">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Replies to customer support email"
            autoComplete="off"
          />
        </Field>
        <Field label="Autonomy">
          <Select
            value={autonomy}
            onChange={(event) => setAutonomy(event.target.value as AutonomyLevel)}
          >
            {AUTONOMY_ORDER.map((level) => (
              <option key={level} value={level}>
                {AUTONOMY[level].label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-[11px] leading-5 text-muted">{AUTONOMY[autonomy].desc}</p>
        </Field>
        <Field
          label="Mailbox account id"
          hint="Optional — the workspace mailbox account this agent sends from. Leave blank to assign later."
        >
          <Input
            value={mailboxId}
            onChange={(event) => setMailboxId(event.target.value)}
            placeholder="optional mailbox account id"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        {formError && <p className="text-xs text-danger">{formError}</p>}
      </form>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-tertiary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-5 text-muted">{hint}</span>}
    </label>
  );
}

function FleetRowSkeleton() {
  return (
    <Card padded>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          <Skeleton w="40%" h={14} />
          <Skeleton w="60%" h={16} />
          <SkeletonText lines={2} />
        </div>
        <div className="w-[200px] space-y-2">
          <Skeleton h={36} />
          <Skeleton h={32} />
        </div>
      </div>
    </Card>
  );
}

function FleetSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <FleetRowSkeleton key={i} />
      ))}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <Card padded className="overflow-hidden border-info/30 bg-info-subtle ring-1 ring-info/20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-info/30 to-info/5 text-info ring-1 ring-info/30">
            <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
              <path
                d="M4 12h4l2-7 4 14 2-7h4"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <p className="text-base font-semibold text-primary">No agents yet.</p>
            <p className="mt-1 text-sm text-tertiary">
              Create your first agent to give it a sending mailbox and an autonomy level. It will
              draft mail into the approval queue for you.
            </p>
          </div>
        </div>
        <Button onClick={onNew} className="shrink-0">
          New agent
        </Button>
      </div>
    </Card>
  );
}

function ErrorState({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <Card padded className="border-danger/30 ring-1 ring-danger/15">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Could not load the fleet.</p>
          <p className="mt-1 text-xs text-danger">{message ?? 'Unknown error.'}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </Card>
  );
}

function NoWorkspace() {
  return (
    <Card padded>
      <p className="text-sm font-medium text-primary">No workspace yet.</p>
      <p className="mt-1 text-sm text-tertiary">
        Your account isn’t a member of an Email-Ops workspace, so there’s no agent fleet to show.
      </p>
    </Card>
  );
}

/** Shown when a real Space is active but scopes out every agent. */
function NoSpaceAgents({ spaceName }: { spaceName: string }) {
  return (
    <Card padded className="overflow-hidden border-info/30 bg-info-subtle ring-1 ring-info/20">
      <div className="flex items-start gap-4">
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-info/30 to-info/5 text-info ring-1 ring-info/30">
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
            <path
              d="M4 12h4l2-7 4 14 2-7h4"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <p className="text-base font-semibold text-primary">
            No agents in <span className="font-mono">{spaceName}</span>.
          </p>
          <p className="mt-1 text-sm text-tertiary">
            This space doesn’t include any agents yet. Add some from “Manage spaces…” in the top bar,
            or switch back to “All”.
          </p>
        </div>
      </div>
    </Card>
  );
}
