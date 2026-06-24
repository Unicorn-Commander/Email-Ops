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

import { useMemo, useState } from 'react';
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
import { useAgents } from '@/components/useAgents';
import { EmailHealthPanel } from '@/components/EmailHealthPanel';
import { agentLabel } from '@/lib/agents';
import type { AgentView, AutonomyLevel } from '@/lib/api';

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
  L1_APPROVE_TO_SEND: {
    label: 'Approve to send',
    desc: 'Drafts; a human approves each send.',
    tone: 'info',
  },
  L2_AUTONOMOUS_AUDIT: {
    label: 'Autonomous',
    desc: 'May send without per-message approval; every send is audited.',
    tone: 'warning',
  },
};

const AUTONOMY_ORDER: AutonomyLevel[] = [
  'L0_DRAFT_ONLY',
  'L1_APPROVE_TO_SEND',
  'L2_AUTONOMOUS_AUDIT',
];
const DEFAULT_AUTONOMY: AutonomyLevel = 'L1_APPROVE_TO_SEND';

export default function AgentsPage() {
  const { workspace, items, load, error, refresh, create, update } = useAgents();
  const [createOpen, setCreateOpen] = useState(false);

  const activeCount = useMemo(() => items.filter((a) => a.active).length, [items]);

  return (
    <div className="space-y-7">
      <Hero
        total={items.length}
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
      ) : items.length === 0 ? (
        <EmptyState onNew={() => setCreateOpen(true)} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PolicyNote />
            <span className="font-mono text-xs text-muted">
              {items.length} {items.length === 1 ? 'agent' : 'agents'}
            </span>
          </div>
          <div className="space-y-3">
            {items.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onUpdate={(body) => update(agent.id, body)}
              />
            ))}
          </div>
        </>
      )}

      <CreateAgentDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreate={create} />
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

/** The subtle "this is the policy you set; enforcement is a follow-up" note. */
function PolicyNote() {
  return (
    <p className="max-w-2xl text-[11px] leading-5 text-muted">
      Autonomy is the policy you set per agent and is recorded here. Enforcement in the send path is
      a follow-up — for now every send still flows through the approval queue.
    </p>
  );
}

function AgentCard({
  agent,
  onUpdate,
}: {
  agent: AgentView;
  onUpdate: (body: { autonomy_level?: AutonomyLevel; active?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
}) {
  const confirm = useConfirm();
  const autonomy = AUTONOMY[agent.autonomy_level];
  const [busy, setBusy] = useState<null | 'autonomy' | 'active'>(null);
  const [cardError, setCardError] = useState<string | null>(null);

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
            <Badge variant={autonomy.tone}>{autonomy.label}</Badge>
            {agent.pending_count > 0 && (
              <Link href="/agent-inbox" title="Review this agent's pending drafts">
                <Badge variant="review" className="transition hover:brightness-110">
                  {agent.pending_count} awaiting
                </Badge>
              </Link>
            )}
          </div>

          {agent.description && (
            <p className="mt-2 max-h-12 overflow-hidden text-xs leading-5 text-secondary">
              {agent.description}
            </p>
          )}

          <p className="mt-2 truncate text-xs text-tertiary">
            {agent.mailbox_address ? (
              <>
                sends from <span className="font-mono text-secondary">{agent.mailbox_address}</span>
              </>
            ) : (
              <span className="text-muted">no mailbox assigned</span>
            )}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-muted">{autonomy.desc}</p>

          {cardError && <p className="mt-3 text-xs text-danger">{cardError}</p>}
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:w-[200px]">
          <label className="block">
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
        </div>
      </div>
    </Card>
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
