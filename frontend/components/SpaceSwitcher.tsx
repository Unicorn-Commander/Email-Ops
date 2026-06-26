'use client';

/**
 * The Top-bar Space switcher — replaces the old "M365 linked" chip.
 *
 * Renders `"<Space> ▾"` (with the active space's color dot / emoji when set) and,
 * on click, a dropdown: **All**, the caller's spaces grouped **Personal** /
 * **Team**, a divider, then **+ New Space** and **Manage spaces…**. Selecting a
 * row sets the ambient active space (`useActiveSpace`) which both the label here
 * and the scoped `/mail` + `/agents` pages read. "New Space" / "Manage spaces"
 * open the manage modal (New focuses a blank create form).
 *
 * Lightweight popover (no extra dep): a button + an absolutely-positioned menu
 * with click-outside + Escape to close, styled to match the existing topbar.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { useActiveSpace } from '@/components/ActiveSpaceProvider';
import { ManageSpacesDialog } from '@/components/ManageSpacesDialog';
import { ALL_SPACE_ID } from '@/lib/activeSpace';
import type { SpaceView } from '@/lib/spacesApi';

export function SpaceSwitcher() {
  const { spaces, activeSpace, activeSpaceId, setActiveSpaceId } = useActiveSpace();
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState<null | 'create' | 'manage'>(null);
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

  const personal = spaces.filter((s) => s.visibility === 'personal');
  const team = spaces.filter((s) => s.visibility === 'team');
  const label = activeSpace ? activeSpace.name : 'All';

  function choose(id: string) {
    setActiveSpaceId(id);
    setOpen(false);
  }

  function openManage(mode: 'create' | 'manage') {
    setManage(mode);
    setOpen(false);
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Switch space"
        className={cn(
          'inline-flex max-w-[170px] items-center gap-1.5 rounded-token border border-subtle bg-surface-raised px-2 py-1 text-xs font-medium text-secondary',
          'transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary',
        )}
      >
        <SpaceGlyph space={activeSpace} />
        <span className="min-w-0 truncate">{label}</span>
        <Caret open={open} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Spaces"
          className="absolute left-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-token-lg border border-border bg-surface-elevated p-1 shadow-token-lg"
        >
          <MenuRow active={activeSpaceId === ALL_SPACE_ID} onClick={() => choose(ALL_SPACE_ID)}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate">All</span>
            <span className="shrink-0 text-[10px] text-muted">everything</span>
          </MenuRow>

          {personal.length > 0 && <GroupLabel>Personal</GroupLabel>}
          {personal.map((s) => (
            <SpaceRow key={s.id} space={s} active={s.id === activeSpaceId} onClick={() => choose(s.id)} />
          ))}

          {team.length > 0 && <GroupLabel>Team</GroupLabel>}
          {team.map((s) => (
            <SpaceRow key={s.id} space={s} active={s.id === activeSpaceId} onClick={() => choose(s.id)} />
          ))}

          <div className="my-1 border-t border-subtle" />

          <MenuRow onClick={() => openManage('create')}>
            <span className="grid h-2.5 w-2.5 shrink-0 place-items-center text-tertiary" aria-hidden>
              +
            </span>
            <span className="min-w-0 flex-1 truncate">New Space</span>
          </MenuRow>
          <MenuRow onClick={() => openManage('manage')}>
            <span className="h-2.5 w-2.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Manage spaces…</span>
          </MenuRow>
        </div>
      )}

      {manage && <ManageSpacesDialog initialMode={manage} onClose={() => setManage(null)} />}
    </div>
  );
}

function SpaceRow({
  space,
  active,
  onClick,
}: {
  space: SpaceView;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <MenuRow active={active} onClick={onClick}>
      <SpaceGlyph space={space} />
      <span className="min-w-0 flex-1 truncate">{space.name}</span>
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

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
      {children}
    </p>
  );
}

/** A space's emoji icon, else a colored dot. `null` space = the neutral "All" dot. */
function SpaceGlyph({ space }: { space: SpaceView | null }) {
  if (space?.icon && space.icon.trim()) {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center text-[12px] leading-none" aria-hidden>
        {space.icon.trim()}
      </span>
    );
  }
  return (
    <span
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: space?.color || 'rgb(var(--text-muted))' }}
      aria-hidden
    />
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
