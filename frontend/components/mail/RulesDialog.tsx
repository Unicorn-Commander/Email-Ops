'use client';

/**
 * RulesDialog — manage a mailbox's mail rules ("file it before I see it").
 *
 * Self-contained management surface in the ScheduleViews register: it fetches
 * the mailbox's rules on open (skeletons → list / empty / error), resets fully
 * on close, and applies row actions optimistically with truthful rollback.
 * Two views swap INLINE within one dialog — LIST (per-rule enabled switch,
 * edit, delete-with-confirm) and EDITOR (name + a conditions builder with an
 * all/any mode toggle + a destination-and-flags action panel). The editor
 * deliberately speaks the SIMPLE shape only: `{ all: [conditions] }` or
 * `{ any: [conditions] }` plus [destination?, MARK_READ?, STOP?]. The backend
 * additionally supports ONE level of nested groups; a rule whose match doesn't
 * fit the flat shape (nested groups / mixed modes) is labelled "advanced
 * matching", and the editor states — before it happens — that saving replaces
 * those conditions wholesale.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select, cn, useConfirm } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { ApiError } from '@/lib/api';
import {
  MAX_MATCH_CONDITIONS_PER_GROUP,
  MAX_RULES_PER_MAILBOX,
  RULE_NAME_MAX,
  countConditions,
  createMailRule,
  deleteMailRule,
  flattenSimpleMatch,
  listMailRules,
  updateMailRule,
  type MailRuleView,
  type MatchNode,
  type RuleAction,
  type RuleField,
  type RuleMatchMode,
  type RuleOp,
} from '@/lib/rulesApi';

type Load = 'loading' | 'ready' | 'error';
type View = 'list' | 'editor';

/** Where matching mail lands. 'inbox' = leave it be (no destination action). */
type Destination = 'inbox' | 'move' | 'archive' | 'trash';

/** A folder the "Move to folder…" destination can target. */
export interface RuleFolderOption {
  id: string;
  name: string;
}

export interface RulesDialogProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  mailboxId: string;
  /** Display label for the mailbox the rules act on (address or name). */
  mailboxLabel: string;
  folders: RuleFolderOption[];
}

/** One row in the conditions builder (`key` is a stable client-side id). */
interface ConditionRow {
  key: number;
  field: RuleField;
  op: RuleOp;
  value: string;
}

/* ------------------------------------------------------------------ copy -- */

const FIELD_LABEL: Record<RuleField, string> = {
  from: 'From',
  to: 'To',
  subject: 'Subject',
  fromDomain: 'From domain',
};

const OP_LABEL: Record<RuleOp, string> = {
  equals: 'is',
  contains: 'contains',
  startsWith: 'starts with',
  endsWith: 'ends with',
};

const VALUE_PLACEHOLDER: Record<RuleField, string> = {
  from: 'name@example.com',
  to: 'name@example.com',
  subject: 'Invoice',
  fromDomain: 'example.com',
};

const DESTINATIONS: { value: Destination; label: string }[] = [
  { value: 'inbox', label: 'Keep in Inbox' },
  { value: 'move', label: 'Move to folder…' },
  { value: 'archive', label: 'Archive' },
  { value: 'trash', label: 'Trash' },
];

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

/** "From contains acme.com and/or Subject starts with Invoice" (or the advanced note). */
function summarizeMatch(match: MatchNode): string {
  const simple = flattenSimpleMatch(match);
  if (simple && simple.conditions.length > 0) {
    return simple.conditions
      .map((c) => `${FIELD_LABEL[c.field]} ${OP_LABEL[c.op]} ${c.value}`)
      .join(simple.mode === 'any' ? ' or ' : ' and ');
  }
  if (simple) return 'Any message'; // empty match — server-invalid, but render honestly
  const n = countConditions(match);
  return `Advanced match (${n} condition${n === 1 ? '' : 's'})`;
}

/** "Move to Receipts, mark read" — STOP is implicit and omitted from summaries. */
function summarizeActions(actions: RuleAction[], folders: RuleFolderOption[]): string {
  const parts: string[] = [];
  for (const action of actions) {
    switch (action.type) {
      case 'MOVE_TO_FOLDER': {
        const folder = folders.find((f) => f.id === action.value);
        parts.push(`move to ${folder ? folder.name : 'a folder'}`);
        break;
      }
      case 'ARCHIVE':
        parts.push('archive');
        break;
      case 'TRASH':
        parts.push('move to Trash');
        break;
      case 'MARK_READ':
        parts.push('mark read');
        break;
      case 'STOP':
        break;
      default:
        break;
    }
  }
  if (parts.length === 0) return 'no action';
  const joined = parts.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/* ----------------------------------------------------------------- chrome -- */

function FunnelIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden>
      <path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden>
      <path d="M12 20h9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden>
      <path
        d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A friendly, non-alarming empty panel (icon + one line + optional action). */
function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-overlay text-tertiary">
        {icon}
      </div>
      <p className="text-sm font-medium text-secondary">{title}</p>
      <p className="max-w-[16rem] text-xs text-tertiary">{hint}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-1 py-2.5">
      <div className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-surface-overlay" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-2/3 animate-pulse rounded bg-surface-overlay" />
        <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface-overlay" />
      </div>
    </div>
  );
}

/** Accessible on/off switch for a rule row (optimistic, per-row busy). */
function EnabledSwitch({
  checked,
  disabled,
  label,
  hint,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  /** Tooltip line shown on hover/focus (the switch itself is icon-only). */
  hint?: string;
  onToggle: () => void;
}) {
  return (
    <Tooltip content={hint} disabled={!hint}>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-fast ease-token',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        'disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'border-transparent bg-accent' : 'border-border bg-surface-overlay',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-all duration-fast ease-token',
          checked ? 'left-[17px]' : 'left-[3px]',
        )}
      />
    </button>
    </Tooltip>
  );
}

/** Shared dialog scaffold (ManageShell register) so both views render identically. */
function RulesShell({
  open,
  onOpenChange,
  title,
  description,
  count,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  title: string;
  description: string;
  count: number | null;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2">
          {title}
          {count != null && count > 0 && (
            <span className="rounded-full bg-surface-overlay px-2 py-0.5 text-[11px] font-medium text-secondary tabular-nums">
              {count}
            </span>
          )}
        </span>
      }
      description={description}
      className="max-w-lg"
      footer={footer}
    >
      <div className="max-h-[min(60vh,28rem)] overflow-y-auto">{children}</div>
    </Dialog>
  );
}

/* ----------------------------------------------------------------- dialog -- */

export function RulesDialog({
  open,
  onClose,
  workspaceId,
  mailboxId,
  mailboxLabel,
  folders,
}: RulesDialogProps) {
  const router = useRouter();
  const confirm = useConfirm();

  const [view, setView] = useState<View>('list');
  const [load, setLoad] = useState<Load>('loading');
  const [rules, setRules] = useState<MailRuleView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Editor state (seeded by openCreate / openEdit; null editing = creating).
  const [editing, setEditing] = useState<MailRuleView | null>(null);
  const [name, setName] = useState('');
  const [matchMode, setMatchMode] = useState<RuleMatchMode>('all');
  const [rows, setRows] = useState<ConditionRow[]>([]);
  const [destination, setDestination] = useState<Destination>('inbox');
  const [folderId, setFolderId] = useState('');
  const [markRead, setMarkRead] = useState(false);
  const [stopAfter, setStopAfter] = useState(true);
  /** The rule being edited has a match the simple builder can't represent. */
  const [advanced, setAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const keyRef = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const makeRow = useCallback(
    (): ConditionRow => ({ key: keyRef.current++, field: 'from', op: 'contains', value: '' }),
    [],
  );

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

  useEffect(() => {
    // Reset on close so a reopen (possibly for a DIFFERENT mailbox) never
    // paints the previous open's rows/editor for a frame before the fetch.
    if (!open) {
      setView('list');
      setLoad('loading');
      setRules([]);
      setError(null);
      setBusyId(null);
      setEditing(null);
      setName('');
      setMatchMode('all');
      setRows([]);
      setDestination('inbox');
      setFolderId('');
      setMarkRead(false);
      setStopAfter(true);
      setAdvanced(false);
      setSubmitted(false);
      setFormError(null);
      setSaving(false);
      return;
    }
    if (!workspaceId || !mailboxId) return;
    let alive = true;
    setLoad('loading');
    setError(null);
    void (async () => {
      try {
        const res = await listMailRules(workspaceId, mailboxId);
        if (!alive) return;
        setRules(res.rules); // already sorted by priority — render as returned
        setLoad('ready');
      } catch (err) {
        if (!alive) return;
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load rules.'));
        setLoad('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, workspaceId, mailboxId, reloadKey, guard401]);

  // The list's Edit buttons unmount on the view swap — hand focus to the form.
  useEffect(() => {
    if (view === 'editor') nameInputRef.current?.focus();
  }, [view]);

  /* ------------------------------------------------------------ list flows -- */

  async function toggleEnabled(rule: MailRuleView) {
    if (busyId) return;
    setBusyId(rule.id);
    const next = !rule.enabled;
    const before = rules;
    // Optimistic: flip now; restore if the server disagrees.
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)));
    try {
      const updated = await updateMailRule(workspaceId, mailboxId, rule.id, { enabled: next });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)));
      setError(null);
    } catch (err) {
      setRules(before);
      if (guard401(err)) return;
      setError(messageOf(err, `Could not ${next ? 'turn on' : 'turn off'} “${rule.name}”.`));
    } finally {
      setBusyId(null);
    }
  }

  async function removeRule(rule: MailRuleView) {
    if (busyId) return;
    const ok = await confirm({
      title: `Delete “${rule.name}”?`,
      description:
        'New mail will no longer be filed by this rule. Messages it already handled stay where they are.',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setBusyId(rule.id);
    const before = rules;
    // Optimistic: drop the row now; restore it if the delete didn't happen.
    setRules((prev) => prev.filter((r) => r.id !== rule.id));
    try {
      await deleteMailRule(workspaceId, mailboxId, rule.id);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError(null); // already gone — the optimistic removal was right
      } else {
        setRules(before);
        if (guard401(err)) return;
        setError(messageOf(err, `Could not delete “${rule.name}”.`));
      }
    } finally {
      setBusyId(null);
    }
  }

  /* ---------------------------------------------------------- editor flows -- */

  function openCreate() {
    setEditing(null);
    setName('');
    setMatchMode('all');
    setRows([makeRow()]);
    setDestination('inbox');
    setFolderId('');
    setMarkRead(false);
    setStopAfter(true); // default ON — most rules should be terminal
    setAdvanced(false);
    setSubmitted(false);
    setFormError(null);
    setView('editor');
  }

  function openEdit(rule: MailRuleView) {
    if (busyId) return;
    const simple = flattenSimpleMatch(rule.match);
    setAdvanced(simple === null);
    setMatchMode(simple?.mode ?? 'all');
    setRows(
      simple && simple.conditions.length > 0
        ? simple.conditions.map((c) => ({ key: keyRef.current++, field: c.field, op: c.op, value: c.value }))
        : [makeRow()], // advanced (or empty) match — start empty-but-required
    );
    let dest: Destination = 'inbox';
    let folder = '';
    let mark = false;
    let stop = false;
    for (const action of rule.actions) {
      switch (action.type) {
        case 'MOVE_TO_FOLDER':
          if (dest === 'inbox') {
            dest = 'move';
            folder = action.value ?? '';
          }
          break;
        case 'ARCHIVE':
          if (dest === 'inbox') dest = 'archive';
          break;
        case 'TRASH':
          if (dest === 'inbox') dest = 'trash';
          break;
        case 'MARK_READ':
          mark = true;
          break;
        case 'STOP':
          stop = true;
          break;
        default:
          break; // unknown/legacy action types are ignored (replaced on save)
      }
    }
    setName(rule.name);
    setDestination(dest);
    setFolderId(folder);
    setMarkRead(mark);
    setStopAfter(stop);
    setEditing(rule);
    setSubmitted(false);
    setFormError(null);
    setView('editor');
  }

  function backToList() {
    if (saving) return;
    setView('list');
    setEditing(null);
    setFormError(null);
    setSubmitted(false);
  }

  function patchRow(key: number, patch: Partial<Omit<ConditionRow, 'key'>>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  async function submitRule() {
    if (saving) return;
    setSubmitted(true);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Give this rule a name.');
      return;
    }
    if (trimmedName.length > RULE_NAME_MAX) {
      setFormError(`Keep the name under ${RULE_NAME_MAX} characters.`);
      return;
    }
    const conditions = rows.map((r) => ({ field: r.field, op: r.op, value: r.value.trim() }));
    if (conditions.some((c) => !c.value)) {
      setFormError('Every condition needs a value.');
      return;
    }
    if (destination === 'move' && !folderId) {
      setFormError('Choose a folder to move matching mail into.');
      return;
    }
    if (destination === 'inbox' && !markRead) {
      setFormError('Pick a destination or turn on “Mark as read” — otherwise this rule wouldn’t do anything.');
      return;
    }
    if (!editing && rules.length >= MAX_RULES_PER_MAILBOX) {
      setFormError(`This mailbox already has ${MAX_RULES_PER_MAILBOX} rules — delete one first.`);
      return;
    }

    // Serialize in the pinned order: destination, then MARK_READ, then STOP.
    const actions: RuleAction[] = [];
    if (destination === 'move') actions.push({ type: 'MOVE_TO_FOLDER', value: folderId });
    else if (destination === 'archive') actions.push({ type: 'ARCHIVE' });
    else if (destination === 'trash') actions.push({ type: 'TRASH' });
    if (markRead) actions.push({ type: 'MARK_READ' });
    if (stopAfter) actions.push({ type: 'STOP' });
    // One flat single-mode group — the shape the mode toggle picks between.
    const match: MatchNode = matchMode === 'any' ? { any: conditions } : { all: conditions };

    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await updateMailRule(workspaceId, mailboxId, editing.id, { name: trimmedName, match, actions });
      } else {
        await createMailRule(workspaceId, mailboxId, { name: trimmedName, match, actions });
      }
      setView('list');
      setEditing(null);
      setReloadKey((k) => k + 1); // refetch — priorities/order are server truth
    } catch (err) {
      if (guard401(err)) return;
      setFormError(messageOf(err, editing ? 'Could not save this rule.' : 'Could not create this rule.'));
    } finally {
      setSaving(false);
    }
  }

  /* ----------------------------------------------------------------- shell -- */

  function handleOpenChange(next: boolean) {
    if (next) return;
    if (saving) return; // don't lose an in-flight save to Escape/overlay
    if (view === 'editor') {
      backToList(); // step back instead of discarding the whole dialog
      return;
    }
    onClose();
  }

  const atCap = rules.length >= MAX_RULES_PER_MAILBOX;

  const listFooter = (
    <>
      <Button variant="secondary" size="sm" onClick={onClose}>
        Done
      </Button>
      <Button
        size="sm"
        leading={<PlusIcon className="h-3.5 w-3.5" />}
        disabled={load !== 'ready' || atCap}
        onClick={openCreate}
      >
        New rule
      </Button>
    </>
  );

  const editorFooter = (
    <>
      <Button variant="secondary" size="sm" disabled={saving} onClick={backToList}>
        Cancel
      </Button>
      <Button size="sm" disabled={saving} onClick={() => void submitRule()}>
        {saving ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
      </Button>
    </>
  );

  const listBody = (
    <>
      {load === 'loading' ? (
        <div className="divide-y divide-subtle">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </div>
      ) : load === 'error' ? (
        <EmptyState
          icon={<FunnelIcon className="h-5 w-5" />}
          title="Couldn’t load rules"
          hint={error ?? 'Try again in a moment.'}
          action={
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </Button>
          }
        />
      ) : rules.length === 0 ? (
        <EmptyState
          icon={<FunnelIcon className="h-5 w-5" />}
          title="No rules yet"
          hint="Rules automatically file, archive, or mark mail as it arrives — so your inbox sorts itself."
          action={
            <div className="flex flex-col items-center gap-2">
              <Button size="sm" leading={<PlusIcon className="h-3.5 w-3.5" />} onClick={openCreate}>
                Create a rule
              </Button>
              <Link
                href="/help#rules"
                className="text-[12px] font-medium text-accent hover:underline"
              >
                How rules work →
              </Link>
            </div>
          }
        />
      ) : (
        <ul className="divide-y divide-subtle">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-center gap-3 py-2.5">
              <EnabledSwitch
                checked={rule.enabled}
                disabled={busyId === rule.id}
                label={`${rule.enabled ? 'Turn off' : 'Turn on'} “${rule.name}”`}
                hint={
                  rule.enabled
                    ? 'Rule is on — turn off to stop filing new mail (nothing is deleted)'
                    : 'Rule is off — turn on to file new mail again'
                }
                onToggle={() => void toggleEnabled(rule)}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'truncate text-[13px] font-medium',
                    rule.enabled ? 'text-primary' : 'text-tertiary',
                  )}
                >
                  {rule.name}
                </p>
                <p className={cn('truncate text-[11px]', rule.enabled ? 'text-tertiary' : 'text-muted')}>
                  {summarizeMatch(rule.match)} → {summarizeActions(rule.actions, folders)}
                </p>
                {rule.hit_count > 0 && (
                  <p className="text-[11px] text-muted">
                    Applied {rule.hit_count} {rule.hit_count === 1 ? 'time' : 'times'}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Tooltip content="Edit rule">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit “${rule.name}”`}
                    disabled={busyId === rule.id}
                    onClick={() => openEdit(rule)}
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
                <Tooltip content="Delete rule — mail it already filed stays where it is">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete “${rule.name}”`}
                    disabled={busyId === rule.id}
                    onClick={() => void removeRule(rule)}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </Button>
                </Tooltip>
              </div>
            </li>
          ))}
        </ul>
      )}
      {load === 'ready' && error && (
        <p role="alert" className="px-1 pt-2 text-xs text-danger">
          {error}
        </p>
      )}
      {load === 'ready' && atCap && (
        <p className="px-1 pt-2 text-[11px] text-muted">
          Rule limit reached ({MAX_RULES_PER_MAILBOX} per mailbox). Delete one to add another.
        </p>
      )}
    </>
  );

  const editorBody = (
    <div className="space-y-5">
      {advanced && editing && (
        <div className="rounded-token border border-warning/30 bg-warning-subtle px-3 py-2">
          <p className="text-xs font-medium text-warning">This rule uses advanced matching.</p>
          <p className="mt-0.5 text-[11px] text-warning/80">
            Currently: {summarizeMatch(editing.match)}. It can’t be edited with the simple builder —
            saving will replace its conditions with the ones below.
          </p>
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-tertiary">Name</span>
        <Input
          ref={nameInputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={RULE_NAME_MAX}
          placeholder="File receipts"
          invalid={submitted && name.trim().length === 0}
          autoComplete="off"
        />
      </label>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
            When a message matches
          </span>
          {/* all/any toggle — the pill register of the header count badge. */}
          <div
            role="group"
            aria-label="How the conditions combine"
            className="flex shrink-0 items-center gap-0.5 rounded-full border border-subtle p-0.5"
          >
            {(['all', 'any'] as const).map((mode) => (
              <Tooltip
                key={mode}
                content={
                  mode === 'all'
                    ? 'Every condition must match (AND)'
                    : 'At least one condition must match (OR)'
                }
              >
                <button
                  type="button"
                  aria-pressed={matchMode === mode}
                  onClick={() => setMatchMode(mode)}
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors duration-fast ease-token',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                    matchMode === mode
                      ? 'bg-surface-overlay text-primary'
                      : 'text-tertiary hover:text-secondary',
                  )}
                >
                  {mode === 'all' ? 'All of' : 'Any of'}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={row.key} className="flex flex-wrap items-center gap-2">
              <div className="w-[calc(50%-0.25rem)] sm:w-auto">
                <Select
                  value={row.field}
                  onChange={(e) => patchRow(row.key, { field: e.target.value as RuleField })}
                  aria-label={`Condition ${i + 1}: message part`}
                >
                  <option value="from">From</option>
                  <option value="to">To</option>
                  <option value="subject">Subject</option>
                  <option value="fromDomain">From domain</option>
                </Select>
              </div>
              <div className="w-[calc(50%-0.25rem)] sm:w-auto">
                <Select
                  value={row.op}
                  onChange={(e) => patchRow(row.key, { op: e.target.value as RuleOp })}
                  aria-label={`Condition ${i + 1}: comparison`}
                >
                  <option value="contains">contains</option>
                  <option value="equals">is exactly</option>
                  <option value="startsWith">starts with</option>
                  <option value="endsWith">ends with</option>
                </Select>
              </div>
              <div className="flex min-w-0 basis-full items-center gap-1 sm:flex-1 sm:basis-0">
                <Input
                  value={row.value}
                  onChange={(e) => patchRow(row.key, { value: e.target.value })}
                  placeholder={VALUE_PLACEHOLDER[row.field]}
                  aria-label={`Condition ${i + 1}: value`}
                  invalid={submitted && row.value.trim().length === 0}
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove condition ${i + 1}`}
                  disabled={rows.length === 1}
                  onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== row.key) : prev))}
                  className="shrink-0"
                >
                  ×
                </Button>
              </div>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          leading={<PlusIcon className="h-3.5 w-3.5" />}
          disabled={rows.length >= MAX_MATCH_CONDITIONS_PER_GROUP}
          onClick={() =>
            setRows((prev) =>
              prev.length < MAX_MATCH_CONDITIONS_PER_GROUP ? [...prev, makeRow()] : prev,
            )
          }
        >
          Add condition
        </Button>
        {rows.length >= MAX_MATCH_CONDITIONS_PER_GROUP && (
          <p className="mt-1 text-[11px] text-muted">
            Up to {MAX_MATCH_CONDITIONS_PER_GROUP} conditions per rule.
          </p>
        )}
      </section>

      <fieldset>
        <legend className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-tertiary">
          Then
        </legend>
        <div className="space-y-1.5">
          {DESTINATIONS.map((d) => {
            const moveDisabled = d.value === 'move' && folders.length === 0 && !folderId;
            return (
              <label
                key={d.value}
                className={cn(
                  'flex items-center gap-2 text-sm',
                  moveDisabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer text-secondary',
                )}
              >
                <input
                  type="radio"
                  name="rules-destination"
                  value={d.value}
                  checked={destination === d.value}
                  onChange={() => setDestination(d.value)}
                  disabled={moveDisabled}
                  className="h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed"
                />
                {d.label}
                {d.value === 'move' && moveDisabled && (
                  <span className="text-[11px] text-muted">— no folders yet</span>
                )}
              </label>
            );
          })}
          {destination === 'move' && (
            <div className="pl-[1.375rem] pt-0.5">
              <Select
                value={folderId}
                onChange={(e) => setFolderId(e.target.value)}
                aria-label="Destination folder"
                invalid={submitted && !folderId}
              >
                <option value="">Choose a folder…</option>
                {folderId !== '' && !folders.some((f) => f.id === folderId) && (
                  <option value={folderId}>(missing folder)</option>
                )}
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div className="mt-3 space-y-1.5 border-t border-subtle pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={markRead}
              onChange={(e) => setMarkRead(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
            />
            Mark as read
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              checked={stopAfter}
              onChange={(e) => setStopAfter(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
            />
            Stop processing more rules
          </label>
          <p className="pl-[1.375rem] text-[11px] text-muted">
            Later rules are skipped for mail this rule matches.
          </p>
        </div>
      </fieldset>

      {formError && (
        <p role="alert" className="text-xs text-danger">
          {formError}
        </p>
      )}
    </div>
  );

  return (
    <RulesShell
      open={open}
      onOpenChange={handleOpenChange}
      title={view === 'list' ? 'Rules' : editing ? 'Edit rule' : 'New rule'}
      description={
        view === 'list'
          ? `Automatically file, archive, or mark mail as it arrives in ${mailboxLabel}.`
          : `Runs automatically on new mail in ${mailboxLabel}.`
      }
      count={view === 'list' && load === 'ready' ? rules.length : null}
      footer={view === 'list' ? listFooter : editorFooter}
    >
      {view === 'list' ? listBody : editorBody}
    </RulesShell>
  );
}
