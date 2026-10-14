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

import { useEffect, type RefObject } from 'react';
import { cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { AccountMenu } from '@/components/account/AccountMenu';
import { useTheme } from '@/state/theme';
import {
  SearchIcon,
  PlusIcon,
  SunIcon,
  MoonIcon,
  RobotIcon,
  RefreshIcon,
  ChevronRightIcon,
} from './icons';

/** Why in-app search is unavailable (connected Gmail/Outlook). Empty → search works. */
const DEFAULT_SEARCH_UNAVAILABLE =
  "Search isn't available on connected Gmail/Outlook accounts yet — search in Gmail or Outlook directly";

export function MailTopBar({
  query,
  onQuery,
  searchRef,
  searchAvailable = true,
  searchUnavailableReason = DEFAULT_SEARCH_UNAVAILABLE,
  foldersCollapsed,
  onToggleFolders,
  railCollapsed,
  onToggleRail,
  agentsPaused,
  onTogglePause,
  activeAgentCount,
  onRefresh,
  refreshing,
  onCompose,
  canCompose,
  onHelp,
  onCommandPalette,
}: {
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /**
   * False on connected Gmail/Outlook mailboxes: the backend ignores `q`, so a
   * working-looking search would silently return the unfiltered inbox. Prefer
   * a disabled control with an honest tooltip over a lying one.
   */
  searchAvailable?: boolean;
  /** Plain-language tooltip / aria description when search is unavailable. */
  searchUnavailableReason?: string;
  foldersCollapsed: boolean;
  onToggleFolders: () => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
  agentsPaused: boolean;
  onTogglePause: () => void;
  /** How many active agents there are (null = unknown → generic label). */
  activeAgentCount: number | null;
  /** Refetch the current mailbox view + counts (new-mail arrival). */
  onRefresh: () => void;
  /** True while a refresh is in flight — spins the icon. */
  refreshing: boolean;
  onCompose: () => void;
  canCompose: boolean;
  /** Open the command-center Help dialog (the same one the `?` key opens). */
  onHelp: () => void;
  /** Open the ⌘K command palette. */
  onCommandPalette?: () => void;
}) {
  const { resolved, setPref } = useTheme();

  // ⌘K / Ctrl-K opens the command palette from anywhere on the surface. (The `/`
  // shortcut still focuses the search box for a plain text search when available.)
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

  const searchBox = (
    <label
      className={cn(
        'flex h-10 min-w-0 max-w-[560px] flex-1 items-center gap-2.5 rounded-lg sm:h-8 border border-subtle bg-surface-overlay px-3 text-tertiary transition-colors',
        searchAvailable ? 'hover:border-border' : 'cursor-not-allowed opacity-70',
      )}
    >
      <SearchIcon className="h-[15px] w-[15px] shrink-0" />
      <input
        ref={searchRef}
        value={searchAvailable ? query : ''}
        onChange={(e) => {
          if (searchAvailable) onQuery(e.target.value);
        }}
        placeholder={
          searchAvailable
            ? 'Search all mail, senders, agents…'
            : 'Search not available on this account'
        }
        aria-label="Search"
        aria-disabled={!searchAvailable}
        disabled={!searchAvailable}
        title={searchAvailable ? undefined : searchUnavailableReason}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-primary outline-none placeholder:text-tertiary disabled:cursor-not-allowed"
      />
      <Tooltip content="Command menu — every folder, account, and action in one fuzzy search">
        <button
          type="button"
          aria-label="Open command menu"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCommandPalette?.();
          }}
          className="hidden cursor-pointer rounded-[5px] border border-border bg-surface-base px-1.5 py-px text-[11px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary sm:block mono"
        >
          ⌘K
        </button>
      </Tooltip>
    </label>
  );

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-subtle bg-surface-raised pl-3 pr-2 sm:h-12 sm:gap-3.5 sm:pr-3.5">
      {/* Folders toggle — hands the accounts/folders column back its width. */}
      <Tooltip
        content={foldersCollapsed ? 'Show the accounts & folders pane' : 'Hide the accounts & folders pane'}
      >
        <button
          type="button"
          onClick={onToggleFolders}
          aria-label={foldersCollapsed ? 'Show accounts & folders' : 'Hide accounts & folders'}
          aria-pressed={!foldersCollapsed}
          className="hidden h-8 w-8 place-items-center rounded-lg border border-transparent text-secondary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary lg:grid"
        >
          <ChevronRightIcon
            className={cn('h-[17px] w-[17px] transition-transform', !foldersCollapsed && 'rotate-180')}
          />
        </button>
      </Tooltip>

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

      {searchAvailable ? (
        searchBox
      ) : (
        <Tooltip content={searchUnavailableReason} bubbleClassName="max-w-[320px]">
          <div className="flex min-w-0 max-w-[560px] flex-1">{searchBox}</div>
        </Tooltip>
      )}

      <span className="hidden h-5 w-px shrink-0 bg-border-subtle lg:block" aria-hidden />

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <Tooltip
          content={
            agentsPaused
              ? 'Resume the fleet — agents can draft and (per their level) send again'
              : 'Workspace kill switch: stop every agent from composing or sending until resumed'
          }
        >
          <button
            type="button"
            onClick={onTogglePause}
            aria-pressed={agentsPaused}
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
        </Tooltip>

        <Tooltip
          content={
            railCollapsed
              ? 'Show the agent rail — chat with your agents, watch their activity'
              : 'Hide the agent rail'
          }
        >
          <button
            type="button"
            onClick={onToggleRail}
            aria-label={railCollapsed ? 'Show agent activity rail' : 'Hide agent activity rail'}
            aria-pressed={!railCollapsed}
            className={cn(
              'hidden h-8 w-8 place-items-center rounded-lg border border-transparent transition-colors lg:grid',
              !railCollapsed
                ? 'bg-accent/12 text-accent'
                : 'text-secondary hover:bg-surface-overlay hover:text-primary',
            )}
          >
            <RobotIcon className="h-[17px] w-[17px]" />
          </button>
        </Tooltip>

        <Tooltip content="Refresh mail — refetch this view and the unread counts">
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh mail"
            className="grid h-10 w-10 place-items-center sm:h-8 sm:w-8 rounded-lg border border-transparent text-secondary transition-colors hover:bg-surface-overlay hover:text-primary"
          >
            <RefreshIcon className={cn('h-[17px] w-[17px]', refreshing && 'animate-spin')} />
          </button>
        </Tooltip>

        <Tooltip content="Quick help & shortcuts (?) — the full guide lives under Help in the left nav">
          <button
            type="button"
            onClick={onHelp}
            aria-label="Help — how Email-Ops works"
            className="hidden h-8 w-8 place-items-center sm:grid rounded-lg border border-transparent text-[17px] font-semibold text-secondary transition-colors hover:bg-surface-overlay hover:text-primary"
          >
            ?
          </button>
        </Tooltip>

        <Tooltip content={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <button
            type="button"
            onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
            className="hidden h-8 w-8 place-items-center sm:grid rounded-lg border border-transparent text-secondary transition-colors hover:bg-surface-overlay hover:text-primary"
          >
            {resolved === 'dark' ? (
              <MoonIcon className="h-[17px] w-[17px]" />
            ) : (
              <SunIcon className="h-[17px] w-[17px]" />
            )}
          </button>
        </Tooltip>

        <Tooltip content="New message (c)">
          <button
            type="button"
            onClick={onCompose}
            disabled={!canCompose}
            aria-label="Compose"
            className="flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 text-[13px] sm:h-8 sm:pl-2.5 sm:pr-3.5 font-semibold text-white shadow-[0_2px_8px_-1px_rgb(var(--accent)/0.5)] transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:shadow-none"
          >
            <PlusIcon className="h-[15px] w-[15px]" />
            <span className="hidden sm:inline">Compose</span>
          </button>
        </Tooltip>

        <AccountMenu />
      </div>
    </header>
  );
}
