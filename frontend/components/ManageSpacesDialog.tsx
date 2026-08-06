'use client';

/**
 * "Manage spaces" — create / rename / delete a Space, set Personal | Team, pick a
 * color + icon, and tick which mailboxes + agents belong to it.
 *
 * Mirrors the calm visual language of the Agents create-dialog and SendersDialog:
 * a left list of existing spaces (+ "New space"), a right-hand editor, and inline
 * errors. Membership uses REPLACE semantics — the checklists send the WHOLE id
 * set via `setSpaceMailboxes` / `setSpaceAgents`. The 400 / 403 / 409 surfaced by
 * the backend appear inline (ApiError carries the message).
 *
 * Data comes from `useSpaces` (CRUD; it nudges the ambient `ActiveSpaceProvider`
 * after each mutation), and the membership option lists from `listMailMailboxes`
 * + `listAgents`. The dialog is mounted only while open, so its fetch is lazy.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Dialog, Input, Select, cn, useConfirm } from '@/components/ui';
import { useSpaces } from '@/components/useSpaces';
import { listAgents, type AgentView } from '@/lib/api';
import { listMailMailboxes, type MailboxPick } from '@/lib/mailApi';
import { agentLabel } from '@/lib/agents';
import type { SpaceVisibility, UpdateSpaceBody } from '@/lib/spacesApi';

/** A small, tasteful palette for the optional accent color. */
const COLOR_SWATCHES = [
  '#7c5cff',
  '#34d399',
  '#60a5fa',
  '#fbbf24',
  '#f87171',
  '#e879f9',
  '#22d3ee',
  '#94a3b8',
];

/** True when a ticked set differs from the persisted id list (membership dirty check). */
function setsDiffer(sel: Set<string>, arr: string[]): boolean {
  if (sel.size !== arr.length) return true;
  for (const id of arr) if (!sel.has(id)) return true;
  return false;
}

export function ManageSpacesDialog({
  initialMode,
  onClose,
}: {
  /** 'create' focuses a blank create form; 'manage' selects the first space. */
  initialMode: 'create' | 'manage';
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const { workspace, items, load, error, create, update, remove, setMailboxes, setAgents } =
    useSpaces();

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Editor form state.
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<SpaceVisibility>('personal');
  const [color, setColor] = useState('');
  const [icon, setIcon] = useState('');
  const [mailboxSel, setMailboxSel] = useState<Set<string>>(new Set());
  const [agentSel, setAgentSel] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState<null | 'save' | 'create' | 'delete'>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Membership option sources (best-effort; metadata editing works without them).
  const [mailboxOptions, setMailboxOptions] = useState<MailboxPick[]>([]);
  const [agentOptions, setAgentOptions] = useState<AgentView[]>([]);

  const editing = useMemo(
    () => (selectedId ? items.find((s) => s.id === selectedId) ?? null : null),
    [selectedId, items],
  );

  // In "manage" mode, default to the first space once the list loads.
  useEffect(() => {
    if (initialMode === 'manage' && selectedId === null && items.length > 0) {
      setSelectedId(items[0].id);
    }
  }, [initialMode, items, selectedId]);

  // Sync the editor when the SELECTED space changes. Guarded by a ref so a
  // background refresh of `items` never clobbers in-progress edits, and so a
  // freshly-selected id that hasn't landed in `items` yet waits instead of blanking.
  const lastSyncedRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastSyncedRef.current === selectedId) return;
    const sp = selectedId ? items.find((s) => s.id === selectedId) ?? null : null;
    if (selectedId !== null && sp === null) return; // selected but not loaded yet
    lastSyncedRef.current = selectedId;
    setName(sp?.name ?? '');
    setVisibility(sp?.visibility ?? 'personal');
    setColor(sp?.color ?? '');
    setIcon(sp?.icon ?? '');
    setMailboxSel(new Set(sp?.mailbox_ids ?? []));
    setAgentSel(new Set(sp?.agent_ids ?? []));
    setFormError(null);
  }, [selectedId, items]);

  // Load the mailbox + agent option lists once the workspace resolves.
  useEffect(() => {
    if (!workspace) return;
    let alive = true;
    void (async () => {
      try {
        const [mb, ag] = await Promise.all([
          listMailMailboxes(workspace.workspace_id),
          listAgents(workspace.workspace_id),
        ]);
        if (!alive) return;
        setMailboxOptions(mb.items);
        setAgentOptions(ag.items);
      } catch {
        // Options are best-effort — leave them empty.
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspace]);

  function startCreate() {
    lastSyncedRef.current = undefined; // force a re-sync to blanks
    setSelectedId(null);
  }

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('A name is required.');
      return;
    }
    setBusy('create');
    setFormError(null);
    const res = await create({
      name: trimmed,
      visibility,
      ...(color ? { color } : {}),
      ...(icon.trim() ? { icon: icon.trim() } : {}),
    });
    if (!res.ok || !res.space) {
      setFormError(res.error ?? 'Could not create the space.');
      setBusy(null);
      return;
    }
    const newId = res.space.id;
    // Apply any pre-ticked membership now that the space has an id.
    if (mailboxSel.size > 0) {
      const r = await setMailboxes(newId, [...mailboxSel]);
      if (!r.ok) {
        setFormError(r.error ?? 'Could not set the mailboxes.');
        setBusy(null);
        setSelectedId(newId);
        return;
      }
    }
    if (agentSel.size > 0) {
      const r = await setAgents(newId, [...agentSel]);
      if (!r.ok) {
        setFormError(r.error ?? 'Could not set the agents.');
        setBusy(null);
        setSelectedId(newId);
        return;
      }
    }
    setBusy(null);
    // Switch to edit mode for the new space, but DON'T let the editor-sync effect
    // re-read `items` — the membership refresh may not have propagated to `items`
    // yet, so syncing now would briefly blank the mailboxes/agents we just ticked
    // + persisted. The current form state (name/visibility/color/icon + mailboxSel
    // /agentSel) already reflects exactly what was created, so mark this id synced.
    lastSyncedRef.current = newId;
    setSelectedId(newId);
  }

  async function handleSave() {
    if (!editing) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('A name is required.');
      return;
    }
    setBusy('save');
    setFormError(null);

    // 1. Metadata — only the changed fields (PATCH).
    const body: UpdateSpaceBody = {};
    if (trimmed !== editing.name) body.name = trimmed;
    if (visibility !== editing.visibility) body.visibility = visibility;
    if ((editing.color ?? '') !== color) body.color = color;
    const nextIcon = icon.trim();
    if ((editing.icon ?? '') !== nextIcon) body.icon = nextIcon;
    if (Object.keys(body).length > 0) {
      const r = await update(editing.id, body);
      if (!r.ok) {
        setFormError(r.error ?? 'Could not save the space.');
        setBusy(null);
        return;
      }
    }

    // 2. Mailbox membership (REPLACE) if it changed.
    if (setsDiffer(mailboxSel, editing.mailbox_ids)) {
      const r = await setMailboxes(editing.id, [...mailboxSel]);
      if (!r.ok) {
        setFormError(r.error ?? 'Could not update the mailboxes.');
        setBusy(null);
        return;
      }
    }

    // 3. Agent membership (REPLACE) if it changed.
    if (setsDiffer(agentSel, editing.agent_ids)) {
      const r = await setAgents(editing.id, [...agentSel]);
      if (!r.ok) {
        setFormError(r.error ?? 'Could not update the agents.');
        setBusy(null);
        return;
      }
    }

    setBusy(null);
  }

  async function handleDelete() {
    if (!editing) return;
    const ok = await confirm({
      title: `Delete ${editing.name}?`,
      description:
        'This removes the space for everyone it’s shared with. The mailboxes and agents themselves are not affected.',
      confirmLabel: 'Delete',
      cancelLabel: 'Keep',
      destructive: true,
    });
    if (!ok) return;
    setBusy('delete');
    setFormError(null);
    const res = await remove(editing.id);
    if (!res.ok) {
      setFormError(res.error ?? 'Could not delete the space.');
      setBusy(null);
      return;
    }
    setBusy(null);
    startCreate(); // back to a blank create form
  }

  const mailboxItems = mailboxOptions.map((m) => ({
    id: m.id,
    primary: m.display_name?.trim() || m.email_address,
    secondary: m.email_address,
  }));
  const agentItems = agentOptions.map((a) => ({
    id: a.id,
    primary: a.display_name || agentLabel(a.key),
    secondary: a.key,
  }));

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && busy === null) onClose();
      }}
      title="Spaces"
      description="Group mailboxes and agents into focused spaces. Personal spaces are only yours; team spaces are shared with the workspace."
      className="max-w-2xl"
      footer={
        <Button variant="secondary" size="sm" disabled={busy !== null} onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-[170px_1fr]">
        {/* LEFT — spaces list + new */}
        <div className="space-y-2">
          <Button
            variant="secondary"
            size="sm"
            block
            onClick={startCreate}
            className={cn(selectedId === null && 'border-accent/40 text-primary')}
          >
            + New space
          </Button>
          <div className="max-h-[46vh] space-y-1 overflow-y-auto">
            {load === 'loading' ? (
              <p className="px-1 py-2 text-xs text-muted">Loading spaces…</p>
            ) : items.length === 0 ? (
              <p className="px-1 py-2 text-[11px] leading-5 text-muted">
                No spaces yet — create your first on the right.
              </p>
            ) : (
              items.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSelectedId(s.id)}
                  aria-current={s.id === selectedId}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-token px-2 py-1.5 text-left text-xs transition-colors duration-fast ease-token',
                    s.id === selectedId
                      ? 'bg-surface-overlay text-primary shadow-token'
                      : 'text-tertiary hover:bg-surface-overlay/60 hover:text-primary',
                  )}
                >
                  <SpaceGlyph color={s.color} icon={s.icon} />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <Badge variant={s.visibility === 'team' ? 'info' : 'neutral'}>
                    {s.visibility === 'team' ? 'team' : 'personal'}
                  </Badge>
                </button>
              ))
            )}
          </div>
          {load === 'error' && error && <p className="px-1 text-[11px] text-danger">{error}</p>}
        </div>

        {/* RIGHT — editor */}
        <div className="min-w-0 space-y-3">
          <Field label={editing ? 'Name' : 'New space name'}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Support, Finance, Personal"
              autoFocus={initialMode === 'create'}
              autoComplete="off"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Visibility"
              hint={
                visibility === 'team'
                  ? 'Shared with everyone in the workspace.'
                  : 'Only you can see this space.'
              }
            >
              <Select
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as SpaceVisibility)}
                aria-label="Visibility"
              >
                <option value="personal">Personal</option>
                <option value="team">Team</option>
              </Select>
            </Field>
            <Field label="Icon" hint="Optional — a short emoji shown beside the name.">
              <Input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="🛟"
                maxLength={2}
                autoComplete="off"
              />
            </Field>
          </div>

          <Field label="Color" hint="Optional — a small accent dot in the switcher.">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-label="No color"
                aria-pressed={color === ''}
                onClick={() => setColor('')}
                className={cn(
                  'grid h-7 w-7 place-items-center rounded-full border text-[11px] transition',
                  color === ''
                    ? 'border-accent text-primary'
                    : 'border-subtle text-muted hover:border-border',
                )}
              >
                ∅
              </button>
              {COLOR_SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  style={{ backgroundColor: c }}
                  className={cn(
                    'h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-surface-elevated transition',
                    color === c ? 'ring-accent' : 'ring-transparent hover:ring-border',
                  )}
                />
              ))}
            </div>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Checklist
              title="Mailboxes"
              count={mailboxSel.size}
              empty="No mailboxes in this workspace."
              options={mailboxItems}
              selected={mailboxSel}
              onToggle={(id) => setMailboxSel((s) => toggle(s, id))}
            />
            <Checklist
              title="Agents"
              count={agentSel.size}
              empty="No agents in this workspace."
              options={agentItems}
              selected={agentSel}
              onToggle={(id) => setAgentSel((s) => toggle(s, id))}
            />
          </div>

          {formError && <p className="text-xs text-danger">{formError}</p>}

          <div className="flex items-center justify-between gap-2 pt-1">
            {editing ? (
              <Button
                variant="danger"
                size="sm"
                disabled={busy !== null}
                onClick={() => void handleDelete()}
              >
                {busy === 'delete' ? 'Deleting…' : 'Delete'}
              </Button>
            ) : (
              <span />
            )}
            {editing ? (
              <Button size="sm" disabled={busy !== null} onClick={() => void handleSave()}>
                {busy === 'save' ? 'Saving…' : 'Save changes'}
              </Button>
            ) : (
              <Button size="sm" disabled={busy !== null} onClick={() => void handleCreate()}>
                {busy === 'create' ? 'Creating…' : 'Create space'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** A labelled form field (mirrors the Agents dialog `Field`). */
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

/** A scrollable checkbox list for membership (mailboxes or agents). */
function Checklist({
  title,
  count,
  empty,
  options,
  selected,
  onToggle,
}: {
  title: string;
  count: number;
  empty: string;
  options: { id: string; primary: string; secondary?: string }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="rounded-token border border-subtle bg-surface-base/40 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-tertiary">{title}</span>
        <span className="font-mono text-[11px] text-muted">{count}</span>
      </div>
      {options.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-muted">{empty}</p>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto">
          {options.map((o) => (
            <li key={o.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-token px-1.5 py-1 transition-colors duration-fast hover:bg-surface-overlay/60">
                <input
                  type="checkbox"
                  checked={selected.has(o.id)}
                  onChange={() => onToggle(o.id)}
                  className="h-3.5 w-3.5 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-primary">{o.primary}</span>
                  {o.secondary && (
                    <span className="block truncate font-mono text-[10px] text-muted">
                      {o.secondary}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A small glyph for a space: its emoji icon, else a colored dot. */
function SpaceGlyph({ color, icon }: { color: string | null; icon: string | null }) {
  if (icon && icon.trim()) {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center text-[12px] leading-none" aria-hidden>
        {icon.trim()}
      </span>
    );
  }
  return (
    <span
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: color || 'rgb(var(--text-muted))' }}
      aria-hidden
    />
  );
}
