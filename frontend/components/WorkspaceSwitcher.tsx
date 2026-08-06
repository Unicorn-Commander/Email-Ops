'use client';

/**
 * The Top-bar Organization switcher — the leading tenant-identity chip.
 *
 * Renders `"<Org> ▾"` (the active org's initial glyph + name) and, on click, a
 * dropdown: the caller's orgs (the active one checked), a divider, then
 * **Create organization**, **Manage members…** (admins only), and a
 * **"N pending invitations"** row whenever `/invites/mine` is non-empty. Choosing
 * an org sets the ambient active org (`useActiveWorkspace`), which re-scopes the
 * WHOLE app. Create / Manage / invitations open their respective modals.
 *
 * Mirrors `SpaceSwitcher`: a lightweight popover (no extra dep) — a button + an
 * absolutely-positioned menu with click-outside + Escape to close, styled to
 * match the topbar — and it can hide its label on very small screens. It also
 * ambiently probes the caller's pending invitations (resilient; re-probes on the
 * `'workspace:changed'` event + tab focus) to surface the count.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { CreateOrgDialog } from '@/components/CreateOrgDialog';
import { ManageMembersDialog } from '@/components/ManageMembersDialog';
import { AcceptInvitesDialog } from '@/components/AcceptInvitesDialog';
import { WORKSPACE_CHANGED_EVENT } from '@/lib/activeWorkspace';
import {
  isAdminRole,
  listMyInvites,
  type MyInviteView,
  type MyWorkspace,
} from '@/lib/workspacesApi';

type DialogMode = 'create' | 'members' | 'invites';

export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspace, activeWorkspaceId, setActiveWorkspaceId } =
    useActiveWorkspace();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  const [invites, setInvites] = useState<MyInviteView[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on click-outside or Escape while open.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Ambient: probe the caller's pending invitations so the dropdown can surface
  // them. Resilient (any failure → no badge); re-probes on org change + focus.
  const reloadInvites = useCallback(async () => {
    try {
      const res = await listMyInvites();
      setInvites(res.invites);
    } catch {
      setInvites([]);
    }
  }, []);

  useEffect(() => {
    void reloadInvites();
    const onChanged = () => void reloadInvites();
    window.addEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onChanged);
    return () => {
      window.removeEventListener(WORKSPACE_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onChanged);
    };
  }, [reloadInvites]);

  const isAdmin = isAdminRole(activeWorkspace?.role);
  const label = activeWorkspace ? activeWorkspace.display_name : 'No organization';

  function choose(id: string) {
    setActiveWorkspaceId(id);
    setOpen(false);
  }

  function openDialog(mode: DialogMode) {
    setDialog(mode);
    setOpen(false);
  }

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Switch organization"
        className={cn(
          'inline-flex max-w-[180px] items-center gap-1.5 rounded-token border border-subtle bg-surface-raised px-2 py-1 text-xs font-medium text-secondary',
          'transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary',
        )}
      >
        <OrgGlyph name={activeWorkspace?.display_name ?? null} />
        <span className="hidden min-w-0 truncate sm:inline">{label}</span>
        {invites.length > 0 && (
          <span
            aria-label={`${invites.length} pending invitation${invites.length === 1 ? '' : 's'}`}
            className="grid h-4 min-w-[1rem] shrink-0 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-contrast"
          >
            {invites.length}
          </span>
        )}
        <Caret open={open} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Organizations"
          className="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-token-lg border border-border bg-surface-elevated p-1 shadow-token-lg"
        >
          {workspaces.length === 0 ? (
            <p className="px-2 py-2 text-[11px] leading-5 text-muted">
              You aren&rsquo;t in an organization yet.
            </p>
          ) : (
            workspaces.map((ws) => (
              <OrgRow
                key={ws.workspace_id}
                ws={ws}
                active={ws.workspace_id === activeWorkspaceId}
                onClick={() => choose(ws.workspace_id)}
              />
            ))
          )}

          <div className="my-1 border-t border-subtle" />

          <MenuRow onClick={() => openDialog('create')}>
            <span className="grid h-2.5 w-2.5 shrink-0 place-items-center text-tertiary" aria-hidden>
              +
            </span>
            <span className="min-w-0 flex-1 truncate">Create organization</span>
          </MenuRow>

          {isAdmin && activeWorkspace && (
            <MenuRow onClick={() => openDialog('members')}>
              <span className="h-2.5 w-2.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">Manage members…</span>
            </MenuRow>
          )}

          {invites.length > 0 && (
            <MenuRow onClick={() => openDialog('invites')}>
              <span className="h-2.5 w-2.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {invites.length} pending invitation{invites.length === 1 ? '' : 's'}
              </span>
              <span className="shrink-0 text-[10px] font-medium text-accent">review</span>
            </MenuRow>
          )}
        </div>
      )}

      {dialog === 'create' && <CreateOrgDialog onClose={() => setDialog(null)} />}
      {dialog === 'members' && activeWorkspace && (
        <ManageMembersDialog workspace={activeWorkspace} onClose={() => setDialog(null)} />
      )}
      {dialog === 'invites' && (
        <AcceptInvitesDialog
          invites={invites}
          onClose={() => {
            setDialog(null);
            void reloadInvites();
          }}
        />
      )}
    </div>
  );
}

function OrgRow({
  ws,
  active,
  onClick,
}: {
  ws: MyWorkspace;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <MenuRow active={active} onClick={onClick}>
      <OrgGlyph name={ws.display_name} />
      <span className="min-w-0 flex-1 truncate">{ws.display_name}</span>
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">{ws.role}</span>
      {active && <Check />}
    </MenuRow>
  );
}

function MenuRow({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      aria-current={active || undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-token px-2 py-1.5 text-left text-xs transition-colors duration-fast ease-token',
        active
          ? 'bg-surface-overlay text-primary'
          : 'text-secondary hover:bg-surface-overlay/70 hover:text-primary',
      )}
    >
      {children}
    </button>
  );
}

/** An org's identity glyph — the first letter of its name in a small accent tile. */
function OrgGlyph({ name }: { name: string | null }) {
  const initial = (name?.trim()?.[0] ?? '?').toUpperCase();
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-[9px] font-semibold text-accent-contrast"
      aria-hidden
    >
      {initial}
    </span>
  );
}

function Check() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-accent"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0 text-tertiary transition-transform duration-fast', open && 'rotate-180')}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
