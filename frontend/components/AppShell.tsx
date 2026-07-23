// SPDX-FileCopyrightText: 2026 Magic Unicorn Unconventional Technology & Stuff Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Tooltip } from '@/components/Tooltip';
import { Badge, Button, Select, Skeleton, cn } from '@/components/ui';
import { ConnectedAccountsProvider, useConnectedAccounts } from './ConnectedAccountsProvider';
import { ActiveWorkspaceProvider } from './ActiveWorkspaceProvider';
import { ActiveSpaceProvider } from './ActiveSpaceProvider';
import { UiCommandProvider } from './UiCommandProvider';
import { UiCommandBridge } from './UiCommandBridge';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { SpaceSwitcher } from './SpaceSwitcher';
import { MailIconNav } from './mail/MailIconNav';
import { AccountMenu } from './account/AccountMenu';
import { ResizableEdge } from './ResizableEdge';
import { shellRailPane, usePaneWidth } from '@/state/paneWidths';
import { useAgentInboxPendingCount } from './useAgentInbox';
import { useAgentControls } from './useAgentControls';
import {
  cleanupActivity,
  getStoredUser,
  isAuthenticated,
  undoBatch,
  type CleanupBatchView,
  type EmailOpsUser,
} from '@/lib/api';
import { providerMeta } from '@/lib/cleaner-model';



export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthRoute = pathname?.startsWith('/auth');
  // The root "/" is the public front door: page.tsx decides landing-vs-dashboard.
  // Treat it (and the /auth pages) as public so the shell's login guard doesn't
  // bounce a logged-out visitor to /auth/login before the landing redirect runs.
  const isPublicRoute = isAuthRoute || pathname === '/';
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isPublicRoute) {
      setReady(true);
      return;
    }
    if (!isAuthenticated()) {
      router.replace('/auth/login');
      return;
    }
    setReady(true);
  }, [isPublicRoute, router]);

  if (isPublicRoute) {
    return <>{children}</>;
  }

  if (!ready) {
    return <ShellSkeleton />;
  }

  return (
    <ConnectedAccountsProvider>
      <ActiveWorkspaceProvider>
        <ActiveSpaceProvider>
          {/* Phase C: the agent-driven UI seam. The provider holds page-local
              commands above the routed pages (so they survive router.push); the
              bridge polls + applies, mounted inside every context it reads. */}
          <UiCommandProvider>
            <UiCommandBridge />
            <ProductChrome>{children}</ProductChrome>
          </UiCommandProvider>
        </ActiveSpaceProvider>
      </ActiveWorkspaceProvider>
    </ConnectedAccountsProvider>
  );
}

function ProductChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [railOpen, setRailOpen] = useState(true);
  // Drag-resizable + persisted width for the right Agent Activity rail (the
  // aside has no width transition, so no resizing flag is needed here).
  const railWidth = usePaneWidth(shellRailPane) ?? 320;
  const { agentsPaused, setPaused } = useAgentControls();
  const agentPending = useAgentInboxPendingCount();

  // The webmail client is a full-bleed surface: let it claim the viewport
  // instead of the default centered max-w-7xl reading column.
  const wide = pathname === '/mail' || pathname?.startsWith('/mail/');

  // /mail is the Agent Email Command Center: it renders its OWN 5-zone chrome
  // (top command bar, icon nav, folders, list, reader, agent rail) and claims
  // the whole viewport. The shared context providers (workspace / space / UI
  // commands) live above ProductChrome, so we simply hand it the full screen and
  // skip the global sidebar / top bar / rail here — no double chrome.
  if (wide) {
    return <div className="h-screen overflow-hidden bg-surface-base text-primary">{children}</div>;
  }

  return (
    <div className="h-screen overflow-hidden bg-surface-base text-primary">
      <div className="flex h-screen">
        {/* The shared 52px icon rail — the same nav the /mail cockpit uses, so
            every page carries one consistent Command-center chrome. */}
        <MailIconNav pendingCount={agentPending} />

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            onToggleRail={() => setRailOpen((value) => !value)}
            railOpen={railOpen}
            agentsPaused={agentsPaused}
            onTogglePause={() => setPaused(!agentsPaused)}
          />

          <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-5 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>

        {railOpen && (
          <aside
            style={{ width: railWidth }}
            className="relative hidden shrink-0 border-l border-subtle bg-surface-base/88 backdrop-blur xl:block"
          >
            <ResizableEdge
              store={shellRailPane}
              edge="left"
              target="parent"
              label="Resize agent activity rail"
            />
            <AgentRail paused={agentsPaused} onPause={() => setPaused(true)} />
          </aside>
        )}
      </div>
    </div>
  );
}


function Topbar({
  onToggleRail,
  railOpen,
  agentsPaused,
  onTogglePause,
}: {
  onToggleRail: () => void;
  railOpen: boolean;
  agentsPaused: boolean;
  onTogglePause: () => void;
}) {
  const { accounts, activeProvider, setActiveProvider, loading } = useConnectedAccounts();
  const activeMeta = providerMeta(activeProvider);
  const user = getStoredUser<EmailOpsUser>();

  return (
    <header className="shrink-0 border-b border-subtle bg-surface-raised">
      <div className="flex h-12 items-center gap-3 pl-3 pr-3.5">
        {/* Brand mark — the icon rail is brand-less, so identity lives here (matches /mail). */}
        <div className="flex items-center gap-2.5 pr-1">
          <div className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-sm font-bold text-white shadow-[0_2px_8px_-1px_rgb(var(--accent)/0.55)]">
            ◐
          </div>
          <div className="hidden text-[14px] font-semibold tracking-[-0.01em] text-primary sm:block">
            Email-Ops <span className="font-medium text-tertiary">/ Command</span>
          </div>
        </div>

        {/* Leading tenant-identity slot: the active organization (outer tenant). */}
        <WorkspaceSwitcher />

        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          <span
            className={cn(
              'grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br text-xs font-semibold text-primary ring-1 ring-border',
              activeMeta.accentClass,
            )}
          >
            {activeMeta.initial}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium text-primary">{activeMeta.mailboxLabel}</p>
              <SpaceSwitcher />
            </div>
            <p className="truncate text-[11px] text-tertiary">
              {user?.email ?? 'Headers and metadata only'}
            </p>
          </div>
        </div>

        <div className="w-[150px] sm:w-[190px]">
          <Select
            aria-label="Active mailbox"
            value={activeProvider}
            disabled={loading}
            onChange={(event) => setActiveProvider(event.target.value as typeof activeProvider)}
            className="bg-surface-raised text-sm"
          >
            {accounts.map((account) => {
              const meta = providerMeta(account.provider);
              return (
                <option key={account.provider} value={account.provider}>
                  {meta.shortLabel} {account.linked ? 'linked' : 'not linked'}
                </option>
              );
            })}
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Tooltip content="Command menu — jump anywhere, run any action (⌘K on the Mail page)">
            <div className="hidden rounded-token border border-subtle bg-surface-raised px-2.5 py-1.5 text-xs text-tertiary lg:block">
              Cmd+K
            </div>
          </Tooltip>
          <Tooltip content="Help — the full guide to mail, agents, approvals, and autonomy">
            <Link
              href="/help"
              aria-label="Open the help guide"
              className="grid h-8 w-8 place-items-center rounded-token text-[15px] font-semibold text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary"
            >
              ?
            </Link>
          </Tooltip>
          <ThemeToggle />
          <Tooltip
            content={
              agentsPaused
                ? 'Resume the fleet — agents can draft and (per their level) send again'
                : 'Workspace kill switch: stop every agent from composing or sending until resumed'
            }
          >
            <Button
              variant={agentsPaused ? 'secondary' : 'ghost'}
              size="sm"
              onClick={onTogglePause}
              className={cn(
                'hidden sm:inline-flex',
                agentsPaused && 'border-warning/30 bg-warning-subtle text-warning',
              )}
            >
              {agentsPaused ? 'Agents paused' : 'Pause all agents'}
            </Button>
          </Tooltip>
          <Tooltip content={railOpen ? 'Hide the agent activity rail' : 'Show the agent activity rail'}>
            <Button variant="ghost" size="sm" onClick={onToggleRail} className="hidden xl:inline-flex">
              {railOpen ? 'Hide rail' : 'Show rail'}
            </Button>
          </Tooltip>
          <AccountMenu size={30} />
        </div>
      </div>
    </header>
  );
}

function AgentRail({ paused, onPause }: { paused: boolean; onPause: () => void }) {
  const { activeProvider, activeAccount } = useConnectedAccounts();
  const meta = providerMeta(activeProvider);
  const [items, setItems] = useState<CleanupBatchView[]>([]);
  const [filter, setFilter] = useState<'all' | 'trash' | 'delete' | 'pending' | 'undone'>('all');
  const [undoingId, setUndoingId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void cleanupActivity(activeProvider)
      .then((res) => {
        if (mounted) setItems(res.items ?? []);
      })
      .catch(() => {
        if (mounted) setItems([]);
      });
    return () => {
      mounted = false;
    };
  }, [activeProvider, paused]);

  const filtered = useMemo(
    () =>
      items.filter((item) =>
        filter === 'all' ? true : item.mode === filter || item.state === filter,
      ),
    [filter, items],
  );
  const rows = useMemo(
    () => [
      {
        tone: activeAccount.linked ? 'success' : 'warning',
        title: activeAccount.linked ? 'Broker token available' : 'Provider sign-in needed',
        body: activeAccount.linked
          ? `${meta.label} can be analyzed through the broker token.`
          : `${meta.label} has no linked broker token yet.`,
      },
      {
        tone: 'info',
        title: 'Read fence active',
        body: 'Dashboard and insights call stats/analyze only. No cleanup tools are mounted here.',
      },
      {
        tone: paused ? 'warning' : 'success',
        title: paused ? 'Agents paused globally' : 'Agent in observe mode',
        body: paused
          ? 'Autonomous work is stopped until resumed.'
          : 'The agent can log observations and stage review, not execute writes.',
      },
    ],
    [activeAccount.linked, meta.label, paused],
  );

  const handleUndo = useCallback(
    async (item: CleanupBatchView) => {
      setUndoingId(item.id);
      try {
        await undoBatch(activeProvider, item.id);
        const res = await cleanupActivity(activeProvider);
        setItems(res.items ?? []);
      } finally {
        setUndoingId(null);
      }
    },
    [activeProvider],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-subtle p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-primary">Agent Activity</p>
            <p className="mt-1 text-xs text-tertiary">Live audit rail, separate from chat.</p>
          </div>
          <Badge variant={paused ? 'warning' : 'success'} dot>
            {paused ? 'paused' : 'observing'}
          </Badge>
        </div>
        <div className="mt-3">
          <Select
            aria-label="Activity filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            className="bg-surface-raised text-xs"
          >
            <option value="all">All</option>
            <option value="trash">Trash</option>
            <option value="delete">Delete</option>
            <option value="pending">Pending</option>
            <option value="undone">Undone</option>
          </Select>
        </div>
        <Button
          variant={paused ? 'secondary' : 'ghost'}
          size="sm"
          block
          onClick={onPause}
          className="mt-3"
        >
          Pause all agents
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {filtered.length > 0 && (
          <div className="space-y-2">
            {filtered.map((item) => (
              <div key={item.id} className="rounded-token-lg border border-subtle bg-surface-raised p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-primary">
                      {item.action} · {item.mode}
                    </p>
                    <p className="mt-1 max-h-10 overflow-hidden text-[11px] leading-5 text-tertiary">
                      {item.summary}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      {item.provider} · {item.state}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 px-2 text-[11px]"
                    disabled={!item.undoable || undoingId === item.id}
                    onClick={() => void handleUndo(item)}
                  >
                    Undo
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {rows.map((row) => (
          <div key={row.title} className="rounded-token-lg border border-subtle bg-surface-raised p-3">
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'mt-1 h-2 w-2 rounded-full',
                  row.tone === 'success'
                    ? 'bg-success'
                    : row.tone === 'warning'
                      ? 'bg-warning'
                      : 'bg-info',
                )}
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-primary">{row.title}</p>
                <p className="mt-1 text-xs leading-5 text-tertiary">{row.body}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-subtle p-4">
        <p className="text-[11px] leading-5 text-tertiary">
          Privacy boundary: analysis reads headers and metadata only, never message content.
        </p>
      </div>
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-screen bg-surface-base">
      <div className="hidden w-[220px] border-r border-subtle p-3 md:block">
        <Skeleton w={36} h={36} circle />
        <div className="mt-8 space-y-3">
          <Skeleton h={40} />
          <Skeleton h={40} />
          <Skeleton h={40} />
        </div>
      </div>
      <div className="flex-1">
        <div className="h-16 border-b border-subtle px-6 py-4">
          <Skeleton w={220} h={18} />
        </div>
        <div className="space-y-4 p-6">
          <Skeleton h={120} />
          <Skeleton h={220} />
        </div>
      </div>
    </div>
  );
}

