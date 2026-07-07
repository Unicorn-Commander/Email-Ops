'use client';

/**
 * Zone: the top command bar of the Agent Email Command Center.
 *
 * Left → right: brand mark + org switcher (tenant identity / SSO), the ⌘K search
 * (wired to the real mail search `q`), then the action cluster — the pause-agents
 * pill (real kill switch), folders + agent-rail toggles, theme toggle, Compose,
 * and an avatar that signs out. This replaces the global AppShell top bar on the
 * full-bleed /mail surface, so every affordance it used to host lives here.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { useTheme } from '@/state/theme';
import {
  clearSession,
  fetchProfile,
  getStoredUser,
  setSession,
  getToken,
  type EmailOpsUser,
} from '@/lib/api';
import {
  SearchIcon,
  PlusIcon,
  SunIcon,
  MoonIcon,
  RobotIcon,
  ChevronRightIcon,
  GearIcon,
} from './icons';

function initialsOf(user: EmailOpsUser | null): string {
  const first = user?.firstName?.trim() ?? '';
  const last = user?.lastName?.trim() ?? '';
  if (first || last) return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || 'YO';
  const handle = (user?.username || user?.email || 'You').trim();
  const parts = handle.split(/[@\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.slice(0, 2) || 'YO').toUpperCase();
}

/**
 * The stored session only holds the token (SSO stored `null` for the user), so
 * the avatar fell back to "YO". Hydrate the real profile (name + Keycloak
 * `picture`) once on mount so existing sessions get correct initials/photo
 * without needing to sign in again.
 */
function useHydratedUser(): EmailOpsUser | null {
  const [user, setUser] = useState<EmailOpsUser | null>(() => getStoredUser<EmailOpsUser>());
  useEffect(() => {
    // Re-hydrate until the profile carries a resolved `picture` field (URL or an
    // explicit null). Sessions stored before the photo wiring lack the key, so
    // this picks up the avatar once without a re-login, then stops.
    if (user && user.picture !== undefined) return;
    const token = getToken();
    if (!token) return;
    let alive = true;
    fetchProfile(token)
      .then((p) => {
        if (!alive) return;
        setSession(token, p);
        setUser(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user]);
  return user;
}

/** Avatar disc — the Keycloak photo when we have one, else gradient initials. */
function Avatar({ user, size }: { user: EmailOpsUser | null; size: number }) {
  const cls = 'shrink-0 overflow-hidden rounded-full';
  if (user?.picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.picture}
        alt=""
        width={size}
        height={size}
        className={cn(cls, 'object-cover')}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cn(
        cls,
        'grid place-items-center bg-gradient-to-br from-[#f0883e] to-[#d9534f] font-semibold text-white',
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initialsOf(user)}
    </span>
  );
}

export function MailTopBar({
  query,
  onQuery,
  searchRef,
  foldersCollapsed,
  onToggleFolders,
  railCollapsed,
  onToggleRail,
  agentsPaused,
  onTogglePause,
  activeAgentCount,
  onCompose,
  canCompose,
  onHelp,
  onCommandPalette,
}: {
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  foldersCollapsed: boolean;
  onToggleFolders: () => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
  agentsPaused: boolean;
  onTogglePause: () => void;
  /** How many active agents there are (null = unknown → generic label). */
  activeAgentCount: number | null;
  onCompose: () => void;
  canCompose: boolean;
  /** Open the command-center Help dialog (the same one the `?` key opens). */
  onHelp: () => void;
  /** Open the ⌘K command palette. */
  onCommandPalette?: () => void;
}) {
  const { resolved, setPref } = useTheme();
  const user = useHydratedUser();

  // ⌘K / Ctrl-K opens the command palette from anywhere on the surface. (The `/`
  // shortcut still focuses the search box for a plain text search.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        onCommandPalette?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCommandPalette]);

  const pauseLabel = agentsPaused
    ? 'Agents paused'
    : activeAgentCount == null
      ? 'Agents active'
      : `${activeAgentCount} agent${activeAgentCount === 1 ? '' : 's'} active`;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3.5 border-b border-subtle bg-surface-raised pl-3 pr-3.5">
      {/* Folders toggle — hands the accounts/folders column back its width. */}
      <button
        type="button"
        onClick={onToggleFolders}
        aria-label={foldersCollapsed ? 'Show accounts & folders' : 'Hide accounts & folders'}
        aria-pressed={!foldersCollapsed}
        title={foldersCollapsed ? 'Show accounts & folders' : 'Hide accounts & folders'}
        className="hidden h-8 w-8 place-items-center rounded-lg border border-transparent text-secondary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary lg:grid"
      >
        <ChevronRightIcon
          className={cn('h-[17px] w-[17px] transition-transform', !foldersCollapsed && 'rotate-180')}
        />
      </button>

      <div className="flex items-center gap-2.5 pr-1">
        <div className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-sm font-bold text-white shadow-[0_2px_8px_-1px_rgb(var(--accent)/0.55)]">
          ◐
        </div>
        <div className="hidden text-[14px] font-semibold tracking-[-0.01em] text-primary sm:block">
          Email-Ops <span className="font-medium text-tertiary">/ Command</span>
        </div>
      </div>

      <div className="hidden md:block">
        <WorkspaceSwitcher />
      </div>

      <label className="flex h-8 max-w-[560px] flex-1 items-center gap-2.5 rounded-lg border border-subtle bg-surface-overlay px-3 text-tertiary transition-colors hover:border-border">
        <SearchIcon className="h-[15px] w-[15px] shrink-0" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search all mail, senders, agents…"
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-primary outline-none placeholder:text-tertiary"
        />
        <kbd
          title="Open command menu"
          className="hidden rounded-[5px] border border-border bg-surface-base px-1.5 py-px text-[11px] text-tertiary sm:block mono"
        >
          ⌘K
        </kbd>
      </label>

      <span className="hidden h-5 w-px shrink-0 bg-border-subtle lg:block" aria-hidden />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onTogglePause}
          aria-pressed={agentsPaused}
          title={agentsPaused ? 'Resume all agents' : 'Pause all agents'}
          className={cn(
            'hidden h-8 items-center gap-2 rounded-lg border px-3 pl-2.5 text-[12px] font-medium transition-colors sm:flex',
            agentsPaused
              ? 'border-warning/60 bg-warning/[0.08] text-warning'
              : 'border-border text-secondary hover:border-warning/60 hover:text-primary',
          )}
        >
          <span
            className={cn(
              'h-[7px] w-[7px] rounded-full',
              agentsPaused
                ? 'bg-warning shadow-[0_0_0_3px_rgb(var(--warning)/0.2)]'
                : 'bg-success shadow-[0_0_0_3px_rgb(var(--success)/0.18)]',
            )}
          />
          {pauseLabel}
        </button>

        <button
          type="button"
          onClick={onToggleRail}
          aria-pressed={!railCollapsed}
          title="Toggle agent activity"
          className={cn(
            'grid h-8 w-8 place-items-center rounded-lg border border-transparent transition-colors',
            !railCollapsed
              ? 'bg-accent/12 text-accent'
              : 'text-secondary hover:bg-surface-overlay hover:text-primary',
          )}
        >
          <RobotIcon className="h-[17px] w-[17px]" />
        </button>

        <button
          type="button"
          onClick={onHelp}
          title="Help — how Email-Ops works (?)"
          aria-label="Help — how Email-Ops works"
          className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-[15px] font-semibold text-secondary transition-colors hover:bg-surface-overlay hover:text-primary"
        >
          ?
        </button>

        <button
          type="button"
          onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}
          title="Toggle theme"
          aria-label="Toggle theme"
          className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-secondary transition-colors hover:bg-surface-overlay hover:text-primary"
        >
          {resolved === 'dark' ? (
            <MoonIcon className="h-[17px] w-[17px]" />
          ) : (
            <SunIcon className="h-[17px] w-[17px]" />
          )}
        </button>

        <button
          type="button"
          onClick={onCompose}
          disabled={!canCompose}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-accent pl-2.5 pr-3.5 text-[13px] font-semibold text-white shadow-[0_2px_8px_-1px_rgb(var(--accent)/0.5)] transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:shadow-none"
        >
          <PlusIcon className="h-[15px] w-[15px]" />
          <span className="hidden sm:inline">Compose</span>
        </button>

        <AccountMenu user={user} />
      </div>
    </header>
  );
}

function AccountMenu({ user }: { user: EmailOpsUser | null }) {
  const router = useRouter();
  const { resolved, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
    user?.username ||
    user?.email ||
    'Signed in';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user?.email ?? 'Account'}
        aria-label="Account menu"
        className={cn(
          'shrink-0 rounded-full transition-shadow',
          open && 'ring-2 ring-accent/60 ring-offset-2 ring-offset-surface-raised',
        )}
      >
        <Avatar user={user} size={30} />
      </button>

      {open && (
        <div
          role="menu"
          className="eops-rise-in absolute right-0 top-[calc(100%+8px)] z-50 w-64 overflow-hidden rounded-xl border border-subtle bg-surface-overlay shadow-pop"
        >
          <div className="flex items-center gap-3 border-b border-subtle px-3.5 py-3">
            <Avatar user={user} size={36} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-primary">{name}</span>
              {user?.email && (
                <span className="block truncate text-[12px] text-tertiary">{user.email}</span>
              )}
            </span>
          </div>

          <div className="p-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary"
            >
              {resolved === 'dark' ? (
                <SunIcon className="h-4 w-4" />
              ) : (
                <MoonIcon className="h-4 w-4" />
              )}
              {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                router.push('/accounts');
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary"
            >
              <GearIcon className="h-4 w-4" />
              Accounts &amp; settings
            </button>
          </div>

          <div className="border-t border-subtle p-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                clearSession();
                router.replace('/auth/login');
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <SignOutIcon className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
      <path d="M10 17l-5-5 5-5" />
      <path d="M5 12h11" />
    </svg>
  );
}
