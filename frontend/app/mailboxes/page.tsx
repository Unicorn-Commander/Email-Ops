'use client';

/**
 * Mailboxes — the per-workspace sending-identity registry + provisioning admin.
 *
 * Every piece of mail leaves a workspace from a mailbox: a human's own box, an
 * agent's sending box, or a shared team box. This view lets a human SEE and
 * MANAGE them — grouped by owner (Mine/Human · Agents · Shared) with each box's
 * address, provisioning state, agent count, and active flag — create a new box,
 * and edit a box's name / active flag. Below the registry sits the workspace's
 * **provisioning policy**: the governance for who may create/edit mailboxes and
 * agents (editing the policy requires ADMIN).
 *
 * Mirrors the Agents view: a `load` discriminator over loading / empty / error /
 * no-workspace, the active-workspace resolution every route is scoped to, and
 * inline 409/403 surfacing (no toast lib). Calm Control: low-chrome cards, no
 * spinners beyond the skeleton.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { EmailHealthPanel } from '@/components/EmailHealthPanel';
import { Tooltip } from '@/components/Tooltip';
import {
  ApiError,
  type MyWorkspace,
} from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import {
  createMailbox,
  listMailboxes,
  updateMailbox,
  type CreateMailboxBody,
  type MailboxOwnerKind,
  type MailboxProvisionState,
  type MailboxView,
  type UpdateMailboxBody,
} from '@/lib/mailboxApi';
import {
  getProvisioningPolicy,
  setProvisioningPolicy,
  type ApproverRole,
  type ProvisioningMode,
  type ProvisioningPolicyPatch,
  type ProvisioningPolicyView,
} from '@/lib/provisioningApi';

type Load = 'loading' | 'ready' | 'error';

/** Owner-kind copy + badge tone (single source of truth). */
const OWNER: Record<MailboxOwnerKind, { label: string; tone: BadgeVariant; hint: string }> = {
  HUMAN: {
    label: 'Human',
    tone: 'info',
    hint: 'A person owns this address — agent-initiated mail from it always needs a human approval',
  },
  AGENT: {
    label: 'Agent',
    tone: 'accent',
    hint: "An AI agent's own send identity — its autonomy level (L0/L1/L2) governs what sends without approval",
  },
  SHARED: {
    label: 'Shared',
    tone: 'protected',
    hint: 'A team address — treated like a human mailbox: agent sends from it always need approval',
  },
};

const OWNER_ORDER: MailboxOwnerKind[] = ['HUMAN', 'AGENT', 'SHARED'];

/** The section heading for each owner group. */
const GROUP_HEADING: Record<MailboxOwnerKind, string> = {
  HUMAN: 'Mine / Human',
  AGENT: 'Agents',
  SHARED: 'Shared',
};

/** Provisioning state → human copy + badge tone. */
const PROVISION: Record<MailboxProvisionState, { label: string; tone: BadgeVariant; hint: string }> = {
  REGISTERED: {
    label: 'registered',
    tone: 'neutral',
    hint: 'Recorded here but not yet created on the mail engine',
  },
  PROVISIONING: {
    label: 'provisioning',
    tone: 'info',
    hint: 'Being created on the mail engine right now',
  },
  PROVISIONED: {
    label: 'provisioned',
    tone: 'success',
    hint: 'Live on the mail engine — it can receive and send',
  },
  PROVISION_FAILED: {
    label: 'provision failed',
    tone: 'danger',
    hint: 'Creating it on the mail engine failed — retry or check the engine configuration',
  },
};

const DEFAULT_OWNER_KIND: MailboxOwnerKind = 'HUMAN';

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** Result of a create/update — lets the caller show inline feedback. */
interface MutationOutcome {
  ok: boolean;
  /** The HTTP status, when the failure was an ApiError (lets callers branch). */
  status?: number;
  error?: string;
}

export default function MailboxesPage() {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<MyWorkspace | null>(null);
  const [hasWorkspace, setHasWorkspace] = useState(true);
  const [items, setItems] = useState<MailboxView[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // A 401 anywhere means the session lapsed — bounce to login (suite pattern).
  const guard401 = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/auth/login');
        return true;
      }
      return false;
    },
    [router],
  );

  const fetchFor = useCallback(
    async (ws: MyWorkspace, silent = false) => {
      if (!silent) setLoad('loading');
      try {
        const res = await listMailboxes(ws.workspace_id);
        setItems(res.items);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load mailboxes.'));
        setLoad('error');
      }
    },
    [guard401],
  );

  // Consume the active org (`ActiveWorkspaceProvider`) so the registry re-scopes
  // when it switches; keyed on the workspace id to avoid refetch churn.
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;

  useEffect(() => {
    if (!activeWorkspace) {
      setWorkspace(null);
      setHasWorkspace(false);
      // Settle only once the org layer resolved (no membership → no mailboxes).
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    setWorkspace(activeWorkspace);
    setHasWorkspace(true);
    void fetchFor(activeWorkspace);
  }, [activeWorkspaceId, workspaceLoad, fetchFor]);

  const refresh = useCallback(async () => {
    if (workspace) await fetchFor(workspace);
  }, [workspace, fetchFor]);

  const create = useCallback(
    async (body: CreateMailboxBody): Promise<MutationOutcome> => {
      if (!workspace) return { ok: false, error: 'No active workspace.' };
      try {
        await createMailbox(workspace.workspace_id, body);
        await fetchFor(workspace, true); // silent — no skeleton flash
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        const status = err instanceof ApiError ? err.status : undefined;
        return { ok: false, status, error: messageOf(err, 'Could not create the mailbox.') };
      }
    },
    [workspace, fetchFor, guard401],
  );

  const update = useCallback(
    async (id: string, body: UpdateMailboxBody): Promise<MutationOutcome> => {
      if (!workspace) return { ok: false, error: 'No active workspace.' };
      try {
        await updateMailbox(workspace.workspace_id, id, body);
        await fetchFor(workspace, true);
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        const status = err instanceof ApiError ? err.status : undefined;
        return { ok: false, status, error: messageOf(err, 'Could not update the mailbox.') };
      }
    },
    [workspace, fetchFor, guard401],
  );

  const activeCount = useMemo(() => items.filter((m) => m.active).length, [items]);

  // Group by owner kind, preserving OWNER_ORDER (empty groups are dropped).
  const groups = useMemo(
    () =>
      OWNER_ORDER.map((kind) => ({
        kind,
        rows: items.filter((m) => m.owner_kind === kind),
      })).filter((g) => g.rows.length > 0),
    [items],
  );

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

      {!hasWorkspace && load === 'ready' ? (
        <NoWorkspace />
      ) : load === 'loading' ? (
        <ListSkeleton />
      ) : load === 'error' ? (
        <ErrorState message={error} onRetry={() => void refresh()} />
      ) : items.length === 0 ? (
        <EmptyState onNew={() => setCreateOpen(true)} />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.kind} className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-primary">
                  {GROUP_HEADING[group.kind]}
                </h2>
                <span className="font-mono text-xs text-muted">
                  {group.rows.length}{' '}
                  {group.rows.length === 1 ? 'mailbox' : 'mailboxes'}
                </span>
              </div>
              <div className="space-y-3">
                {group.rows.map((mailbox) => (
                  <MailboxCard
                    key={mailbox.id}
                    mailbox={mailbox}
                    onUpdate={(body) => update(mailbox.id, body)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <CreateMailboxDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={create}
      />

      {workspace && load !== 'loading' && (
        <ProvisioningPolicySection workspaceId={workspace.workspace_id} guard401={guard401} />
      )}
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
                {total > 0 ? `${active} of ${total} active` : 'no mailboxes yet'}
              </Badge>
              <Badge variant="protected">mailboxes &amp; provisioning</Badge>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
              Your sending identities.{' '}
              <span className="bg-gradient-to-br from-accent via-[rgb(var(--accent-2))] to-info bg-clip-text text-transparent">
                One place to govern them.
              </span>
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
              Every message leaves from a mailbox — a person, an agent, or a shared box. Manage who
              sends, what is provisioned, and who is paused.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row lg:items-center">
            <Button variant="secondary" onClick={onRefresh} disabled={loading}>
              Refresh
            </Button>
            <Button onClick={onNew} disabled={disableNew}>
              New mailbox
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

function MailboxCard({
  mailbox,
  onUpdate,
}: {
  mailbox: MailboxView;
  onUpdate: (body: UpdateMailboxBody) => Promise<MutationOutcome>;
}) {
  const confirm = useConfirm();
  const owner = OWNER[mailbox.owner_kind];
  const provision = PROVISION[mailbox.provision_state];
  const [busy, setBusy] = useState<null | 'name' | 'active'>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  // Inline rename: a small edit affordance over display_name.
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(mailbox.display_name ?? '');

  function beginEditName() {
    setNameDraft(mailbox.display_name ?? '');
    setCardError(null);
    setEditingName(true);
  }

  async function saveName() {
    const trimmed = nameDraft.trim();
    const next = trimmed === '' ? null : trimmed;
    if (next === (mailbox.display_name ?? null)) {
      setEditingName(false);
      return;
    }
    setBusy('name');
    setCardError(null);
    const res = await onUpdate({ display_name: next });
    setBusy(null);
    if (res.ok) {
      setEditingName(false);
    } else {
      setCardError(res.error ?? 'Could not rename the mailbox.');
    }
  }

  async function handleToggleActive() {
    if (mailbox.active) {
      const ok = await confirm({
        title: `Deactivate ${mailbox.email_address}?`,
        description:
          'A deactivated mailbox stops sending and is parked. Its records are kept; you can reactivate it any time.',
        confirmLabel: 'Deactivate',
        cancelLabel: 'Keep active',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy('active');
    setCardError(null);
    const res = await onUpdate({ active: !mailbox.active });
    if (!res.ok) setCardError(res.error ?? 'Could not update the mailbox.');
    setBusy(null);
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-sm font-semibold text-primary">
              {mailbox.email_address}
            </span>
            <Tooltip content={owner.hint} bubbleClassName="max-w-[300px]">
              <span tabIndex={0}><Badge variant={owner.tone}>{owner.label}</Badge></span>
            </Tooltip>
            <Tooltip content={provision.hint}>
              <span tabIndex={0}>
                <Badge variant={provision.tone} dot>
                  {provision.label}
                </Badge>
              </span>
            </Tooltip>
            <Tooltip
              content={
                mailbox.active
                  ? 'Active — this mailbox can send and receive'
                  : 'Inactive — parked; it stops sending until reactivated (records are kept)'
              }
            >
              <span tabIndex={0}>
                <Badge variant={mailbox.active ? 'success' : 'neutral'} dot>
                  {mailbox.active ? 'active' : 'inactive'}
                </Badge>
              </span>
            </Tooltip>
            {mailbox.is_default && (
              <Tooltip content="The workspace's fallback send address when no mailbox is specified">
                <span tabIndex={0}><Badge variant="info">default</Badge></span>
              </Tooltip>
            )}
            {mailbox.postmark_lane && (
              <Tooltip content="Outbound delivery for this address rides the Postmark lane">
                <span tabIndex={0}><Badge variant="accent">Postmark lane</Badge></span>
              </Tooltip>
            )}
          </div>

          {editingName ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                placeholder="Display name"
                autoFocus
                autoComplete="off"
                disabled={busy === 'name'}
                className="max-w-xs"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveName();
                  } else if (event.key === 'Escape') {
                    setEditingName(false);
                  }
                }}
              />
              <Button size="sm" disabled={busy === 'name'} onClick={() => void saveName()}>
                {busy === 'name' ? 'Saving…' : 'Save'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === 'name'}
                onClick={() => setEditingName(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={beginEditName}
              className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-token text-left text-xs text-secondary transition hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              title="Edit display name"
            >
              <span className="truncate">
                {mailbox.display_name || <span className="text-muted">No display name</span>}
              </span>
              <span aria-hidden className="text-[11px] text-muted">
                edit
              </span>
            </button>
          )}

          <p className="mt-2 text-[11px] leading-5 text-muted">
            {mailbox.owner_key ? (
              <>
                owner <span className="font-mono text-tertiary">{mailbox.owner_key}</span> ·{' '}
              </>
            ) : null}
            {mailbox.agent_count}{' '}
            {mailbox.agent_count === 1 ? 'agent sends' : 'agents send'} from this mailbox
          </p>

          {cardError && <p className="mt-3 text-xs text-danger">{cardError}</p>}
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:w-[180px]">
          <Button
            variant={mailbox.active ? 'secondary' : 'primary'}
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleToggleActive()}
          >
            {busy === 'active'
              ? mailbox.active
                ? 'Deactivating…'
                : 'Activating…'
              : mailbox.active
                ? 'Deactivate'
                : 'Activate'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function CreateMailboxDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (body: CreateMailboxBody) => Promise<MutationOutcome>;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [ownerKind, setOwnerKind] = useState<MailboxOwnerKind>(DEFAULT_OWNER_KIND);
  const [ownerKey, setOwnerKey] = useState('');
  const [postmarkLane, setPostmarkLane] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function reset() {
    setEmail('');
    setDisplayName('');
    setOwnerKind(DEFAULT_OWNER_KIND);
    setOwnerKey('');
    setPostmarkLane(false);
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
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFormError('An email address is required.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const res = await onCreate({
      email_address: trimmedEmail,
      ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
      owner_kind: ownerKind,
      ...(ownerKey.trim() ? { owner_key: ownerKey.trim() } : {}),
      postmark_lane: postmarkLane,
    });
    if (res.ok) {
      reset();
      onClose();
    } else {
      // Friendlier copy for the two governed failures.
      const friendly =
        res.status === 409
          ? 'A mailbox with that address already exists in this workspace.'
          : res.status === 403
            ? res.error ?? 'The provisioning policy does not allow you to create this mailbox.'
            : res.error ?? 'Could not create the mailbox.';
      setFormError(friendly);
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="New mailbox"
      description="Register a sending identity. Provisioning runs after it is created."
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
            {submitting ? 'Creating…' : 'Create mailbox'}
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
        <Field label="Email address">
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="support@your-domain.com"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Display name" hint="Optional — the friendly name shown on this mailbox.">
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Support"
            autoComplete="off"
          />
        </Field>
        <Field label="Owner kind">
          <Select
            value={ownerKind}
            onChange={(event) => setOwnerKind(event.target.value as MailboxOwnerKind)}
          >
            {OWNER_ORDER.map((kind) => (
              <option key={kind} value={kind}>
                {OWNER[kind].label}
              </option>
            ))}
          </Select>
          {ownerKind === 'AGENT' && (
            <p className="mt-1 text-[11px] leading-5 text-muted">
              Agent mailboxes are higher-trust — your provisioning policy may require an
              administrator to create them.
            </p>
          )}
        </Field>
        <Field
          label="Owner key"
          hint="Optional — the human or agent slug this mailbox belongs to."
        >
          <Input
            value={ownerKey}
            onChange={(event) => setOwnerKey(event.target.value)}
            placeholder="optional owner slug"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={postmarkLane}
            onChange={(event) => setPostmarkLane(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[rgb(var(--accent))]"
          />
          <span className="text-xs leading-5 text-secondary">
            Use the Postmark transactional lane
            <span className="mt-0.5 block text-[11px] text-muted">
              Route this mailbox&rsquo;s mail through the Postmark transactional stream.
            </span>
          </span>
        </label>

        {formError && <p className="text-xs text-danger">{formError}</p>}
      </form>
    </Dialog>
  );
}

// ── Provisioning policy ─────────────────────────────────────────────────────

const MODE_OPTIONS: { value: ProvisioningMode; label: string }[] = [
  { value: 'OPEN', label: 'Open — any member' },
  { value: 'MANAGER', label: 'Manager and up' },
  { value: 'ADMIN_ONLY', label: 'Admins only' },
  { value: 'APPROVAL', label: 'Requires approval' },
];

const ROLE_OPTIONS: { value: ApproverRole; label: string }[] = [
  { value: 'VIEWER', label: 'Viewer' },
  { value: 'MEMBER', label: 'Member' },
  { value: 'MANAGER', label: 'Manager' },
  { value: 'ADMIN', label: 'Admin' },
  { value: 'OWNER', label: 'Owner' },
];

/** The editable mode levers, in display order. */
const MODE_FIELDS: { key: keyof ProvisioningPolicyView; label: string }[] = [
  { key: 'human_mailbox_create_mode', label: 'Create a human mailbox' },
  { key: 'human_mailbox_edit_mode', label: 'Edit a human mailbox' },
  { key: 'agent_mailbox_create_mode', label: 'Create an agent mailbox' },
  { key: 'agent_mailbox_edit_mode', label: 'Edit an agent mailbox' },
  { key: 'agent_create_mode', label: 'Create an agent' },
  { key: 'agent_edit_mode', label: 'Edit an agent' },
];

type PolicyLoad = 'loading' | 'ready' | 'error';

function ProvisioningPolicySection({
  workspaceId,
  guard401,
}: {
  workspaceId: string;
  guard401: (err: unknown) => boolean;
}) {
  const [policy, setPolicy] = useState<ProvisioningPolicyView | null>(null);
  const [draft, setDraft] = useState<ProvisioningPolicyView | null>(null);
  const [load, setLoad] = useState<PolicyLoad>('loading');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const fetchPolicy = useCallback(async () => {
    setLoad('loading');
    try {
      const next = await getProvisioningPolicy(workspaceId);
      setPolicy(next);
      setDraft(next);
      setError(null);
      setLoad('ready');
    } catch (err) {
      if (guard401(err)) return;
      setError(messageOf(err, 'Could not load the provisioning policy.'));
      setLoad('error');
    }
  }, [workspaceId, guard401]);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  // Has the draft diverged from the loaded policy?
  const dirty = useMemo(() => {
    if (!policy || !draft) return false;
    const keys: (keyof ProvisioningPolicyView)[] = [
      ...MODE_FIELDS.map((f) => f.key),
      'approver_min_role',
      'allow_self_service_own_mailbox',
    ];
    return keys.some((k) => policy[k] !== draft[k]);
  }, [policy, draft]);

  function patchDraft<K extends keyof ProvisioningPolicyView>(
    key: K,
    value: ProvisioningPolicyView[K],
  ) {
    setSaved(false);
    setSaveError(null);
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    // Send only the editable fields the UI exposes.
    const patch: ProvisioningPolicyPatch = {
      human_mailbox_create_mode: draft.human_mailbox_create_mode,
      human_mailbox_edit_mode: draft.human_mailbox_edit_mode,
      agent_mailbox_create_mode: draft.agent_mailbox_create_mode,
      agent_mailbox_edit_mode: draft.agent_mailbox_edit_mode,
      agent_create_mode: draft.agent_create_mode,
      agent_edit_mode: draft.agent_edit_mode,
      approver_min_role: draft.approver_min_role,
      allow_self_service_own_mailbox: draft.allow_self_service_own_mailbox,
    };
    try {
      const next = await setProvisioningPolicy(workspaceId, patch);
      setPolicy(next);
      setDraft(next);
      setSaved(true);
    } catch (err) {
      if (guard401(err)) return;
      const status = err instanceof ApiError ? err.status : undefined;
      setSaveError(
        status === 403
          ? 'Editing the policy requires ADMIN.'
          : messageOf(err, 'Could not save the policy.'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padded>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left focus:outline-none"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-primary">Provisioning policy</h2>
          {policy?.is_default && <Badge variant="neutral">Balanced (default)</Badge>}
        </div>
        <span aria-hidden className="text-xs text-muted">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>

      <p className="mt-1 text-[11px] leading-5 text-muted">
        Governs who may create and edit mailboxes and agents in this workspace.
      </p>

      {open && (
        <div className="mt-4">
          {load === 'loading' ? (
            <div className="space-y-3">
              <Skeleton h={14} w="45%" />
              <Skeleton h={36} />
              <Skeleton h={36} />
            </div>
          ) : load === 'error' ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-danger">
                {error ?? 'Could not load the provisioning policy.'}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void fetchPolicy()}>
                Try again
              </Button>
            </div>
          ) : draft && policy ? (
            <div className="space-y-5">
              {policy.is_default && (
                <p className="rounded-token bg-surface-overlay px-3 py-2 text-[11px] leading-5 text-tertiary">
                  Using the default (Balanced) policy. Saving will create an explicit policy for
                  this workspace.
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                {MODE_FIELDS.map((field) => (
                  <PolicyModeField
                    key={field.key}
                    label={field.label}
                    value={draft[field.key] as ProvisioningMode}
                    onChange={(v) => patchDraft(field.key, v as ProvisioningPolicyView[typeof field.key])}
                  />
                ))}
              </div>

              <p className="text-[11px] leading-5 text-muted">
                Agent mailboxes are higher-trust — they default to administrator-only.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-medium text-tertiary">
                    Minimum approver role
                  </span>
                  <Select
                    value={draft.approver_min_role}
                    onChange={(event) =>
                      patchDraft('approver_min_role', event.target.value as ApproverRole)
                    }
                    className="text-xs"
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </Select>
                  <span className="mt-1 block text-[11px] leading-5 text-muted">
                    The role required to approve a gated (Requires approval) action.
                  </span>
                </label>

                <label className="flex items-start gap-2.5 pt-1 sm:pt-6">
                  <input
                    type="checkbox"
                    checked={draft.allow_self_service_own_mailbox}
                    onChange={(event) =>
                      patchDraft('allow_self_service_own_mailbox', event.target.checked)
                    }
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-[rgb(var(--accent))]"
                  />
                  <span className="text-xs leading-5 text-secondary">
                    Allow self-service of one&rsquo;s own mailbox
                    <span className="mt-0.5 block text-[11px] text-muted">
                      A member may create and edit their own mailbox regardless of the modes above.
                    </span>
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle pt-4">
                <div className="min-h-[1.25rem] text-xs">
                  {saveError ? (
                    <span className="text-danger">{saveError}</span>
                  ) : saved ? (
                    <span className="text-success">Policy saved.</span>
                  ) : (
                    <span className="text-muted">
                      {dirty ? 'Unsaved changes.' : 'Editing the policy requires ADMIN.'}
                    </span>
                  )}
                </div>
                <Button size="sm" disabled={saving || !dirty} onClick={() => void handleSave()}>
                  {saving ? 'Saving…' : 'Save policy'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function PolicyModeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ProvisioningMode;
  onChange: (value: ProvisioningMode) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-tertiary">{label}</span>
      <Select
        value={value}
        onChange={(event) => onChange(event.target.value as ProvisioningMode)}
        className="text-xs"
      >
        {MODE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

// ── States ──────────────────────────────────────────────────────────────────

function MailboxRowSkeleton() {
  return (
    <Card padded>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-3">
          <Skeleton w="45%" h={14} />
          <Skeleton w="30%" h={12} />
          <SkeletonText lines={1} />
        </div>
        <div className="w-[180px] space-y-2">
          <Skeleton h={32} />
        </div>
      </div>
    </Card>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <MailboxRowSkeleton key={i} />
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
                d="M3 7l9 6 9-6M3 7v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V7M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <p className="text-base font-semibold text-primary">No mailboxes yet.</p>
            <p className="mt-1 text-sm text-tertiary">
              Register your first mailbox to give a person, an agent, or your team a place to send
              mail from.
            </p>
          </div>
        </div>
        <Button onClick={onNew} className="shrink-0">
          New mailbox
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
          <p className="text-sm font-medium text-primary">Could not load mailboxes.</p>
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
        Your account isn&rsquo;t a member of an Email-Ops workspace, so there are no mailboxes to
        show.
      </p>
    </Card>
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
