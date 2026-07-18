'use client';

/**
 * The Top-bar Space switcher — replaces the old "M365 linked" chip.
 *
 * Renders a space glyph + the active space's name and, on click, a dropdown:
 * the three CANONICAL pseudo-spaces pinned first — **All inboxes** (everything),
 * **My mail** (HUMAN/SHARED mailboxes, i.e. yours + connected accounts) and
 * **Agents** (agent mailboxes) — each with a distinct glyph and a one-line
 * description; then a **Your spaces** section (the caller's real personal +
 * team Spaces, color dot / emoji as configured, team ones tagged); then
 * **+ New Space** and **Manage spaces…**. Selecting a row sets the ambient
 * active space (`useActiveSpace`) which both the label here and the scoped
 * `/mail` + `/agents` pages read — canonical ids resolve to computed
 * owner_kind sets inside the provider. "New Space" / "Manage spaces" open the
 * manage modal (New focuses a blank create form).
 *
 * Lightweight popover (the house menu pattern — same as BulkBar's move menu):
 * a button + an absolutely-positioned `role="menu"`, click-outside + Escape to
 * close, styled to match the existing topbar.
 */

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { useActiveSpace } from '@/components/ActiveSpaceProvider';
import { ManageSpacesDialog } from '@/components/ManageSpacesDialog';
import { AGENTS_SPACE_ID, ALL_SPACE_ID, MY_MAIL_SPACE_ID } from '@/lib/activeSpace';
import type { SpaceView } from '@/lib/spacesApi';

type CanonicalGlyphKind = 'grid' | 'person' | 'bot';

/**
 * The pinned canonical trio (client-only pseudo-spaces the provider resolves).
 * Order is the product order: everything → yours → the fleet's.
 */
const CANONICAL_SPACES: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  glyph: CanonicalGlyphKind;
}> = [
  { id: ALL_SPACE_ID, name: 'All inboxes', description: 'Everything', glyph: 'grid' },
  {
    id: MY_MAIL_SPACE_ID,
    name: 'My mail',
    description: 'Your personal + connected accounts',
    glyph: 'person',
  },
  { id: AGENTS_SPACE_ID, name: 'Agents', description: 'Agent mailboxes', glyph: 'bot' },
];

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

  // Real spaces, personal first then team (each keeps the backend sort inside).
  const personal = spaces.filter((s) => s.visibility === 'personal');
  const team = spaces.filter((s) => s.visibility === 'team');

  // The trigger names the active space. Canonical ids label from the trio table
  // (they stay labeled even while the provider's roster resolution is pending);
  // a real space labels from its resolved view.
  const canonical = CANONICAL_SPACES.find((c) => c.id === activeSpaceId) ?? null;
  const label = canonical ? canonical.name : activeSpace?.name ?? 'All inboxes';

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
        {canonical ? <CanonicalGlyph kind={canonical.glyph} /> : <SpaceGlyph space={activeSpace} />}
        <span className="min-w-0 truncate">{label}</span>
        <Caret open={open} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Spaces"
          className="absolute left-0 top-full z-40 mt-1 w-64 overflow-hidden rounded-token-lg border border-border bg-surface-elevated p-1 shadow-token-lg"
        >
          {CANONICAL_SPACES.map((c) => (
            <MenuRow key={c.id} active={activeSpaceId === c.id} onClick={() => choose(c.id)}>
              <CanonicalGlyph kind={c.glyph} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.name}</span>
                <span className="block truncate text-[10px] font-normal text-muted">
                  {c.description}
                </span>
              </span>
            </MenuRow>
          ))}

          {spaces.length > 0 && (
            <>
              <div className="my-1 border-t border-subtle" />
              <GroupLabel>Your spaces</GroupLabel>
              {personal.map((s) => (
                <SpaceRow
                  key={s.id}
                  space={s}
                  active={s.id === activeSpaceId}
                  onClick={() => choose(s.id)}
                />
              ))}
              {team.map((s) => (
                <SpaceRow
                  key={s.id}
                  space={s}
                  active={s.id === activeSpaceId}
                  onClick={() => choose(s.id)}
                />
              ))}
            </>
          )}

          <div className="my-1 border-t border-subtle" />

          <MenuRow onClick={() => openManage('create')}>
            <span className="grid h-4 w-4 shrink-0 place-items-center text-tertiary" aria-hidden>
              +
            </span>
            <span className="min-w-0 flex-1 truncate">New Space</span>
          </MenuRow>
          <MenuRow onClick={() => openManage('manage')}>
            <span className="h-4 w-4 shrink-0" aria-hidden />
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
      {space.visibility === 'team' && (
        <span className="shrink-0 text-[10px] text-muted">team</span>
      )}
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

/** A space's emoji icon, else a colored dot (a real user Space's own glyph). */
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

/**
 * The canonical trio's glyphs — grid (All inboxes), person (My mail), bot
 * (Agents) — in the house stroke style (currentColor, round caps, 16 viewBox).
 */
function CanonicalGlyph({ kind }: { kind: CanonicalGlyphKind }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4 shrink-0 text-tertiary"
    >
      {kind === 'grid' ? (
        <>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </>
      ) : kind === 'person' ? (
        <>
          <circle cx="8" cy="5" r="2.6" />
          <path d="M2.8 13.6c.8-2.7 2.8-4.1 5.2-4.1s4.4 1.4 5.2 4.1" />
        </>
      ) : (
        <>
          <rect x="2.5" y="6" width="11" height="7" rx="2" />
          <path d="M8 6V3.4" />
          <circle cx="8" cy="2.6" r="0.9" />
          <path d="M5.8 9v1.2M10.2 9v1.2" />
        </>
      )}
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
