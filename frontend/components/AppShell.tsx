'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Badge, Button, Card, Select, Skeleton, cn } from '@/components/ui';
import { ConnectedAccountsProvider, useConnectedAccounts } from './ConnectedAccountsProvider';
import { ActiveWorkspaceProvider } from './ActiveWorkspaceProvider';
import { ActiveSpaceProvider } from './ActiveSpaceProvider';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { SpaceSwitcher } from './SpaceSwitcher';
import { useAgentInboxPendingCount } from './useAgentInbox';
import { useAgentControls } from './useAgentControls';
import {
  clearSession,
  cleanupActivity,
  getStoredUser,
  getToken,
  undoBatch,
  type CleanupBatchView,
  type EmailOpsUser,
} from '@/lib/api';
import { providerMeta } from '@/lib/cleaner-model';

type IconName =
  | 'dashboard'
  | 'accounts'
  | 'insights'
  | 'cleanup'
  | 'shield'
  | 'activity'
  | 'menu'
  | 'mail';

const NAV = [
  { href: '/dashboard', label: 'Overview', eyebrow: 'Needs-you', icon: 'dashboard' as const, tone: 'accent' as const },
  { href: '/mail', label: 'Mail', eyebrow: 'Your inboxes', icon: 'mail' as const, tone: 'accent' as const },
  { href: '/agent-inbox', label: 'Agent Inbox', eyebrow: 'Approve & send', icon: 'mail' as const, tone: 'review' as const },
  { href: '/agents', label: 'Agents', eyebrow: 'Fleet & autonomy', icon: 'activity' as const, tone: 'info' as const },
  { href: '/mailboxes', label: 'Mailboxes', eyebrow: 'Identities', icon: 'accounts' as const, tone: 'info' as const },
  { href: '/accounts', label: 'Accounts', eyebrow: 'Broker access', icon: 'accounts' as const, tone: 'info' as const },
  { href: '/insights', label: 'Insights', eyebrow: 'Read-only scan', icon: 'insights' as const, tone: 'keep' as const },
  { href: '/cleanup', label: 'Cleanup', eyebrow: 'Safety workbench', icon: 'cleanup' as const, tone: 'review' as const },
];

const NAV_TONE: Record<'accent' | 'info' | 'keep' | 'review', { row: string; chipActive: string; chipIdle: string }> = {
  accent: {
    row: 'bg-accent/14 ring-accent/30',
    chipActive: 'bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-white shadow-lg shadow-accent/40 ring-1 ring-white/15',
    chipIdle: 'bg-gradient-to-br from-accent to-accent/55 text-white shadow-md shadow-accent/25 ring-1 ring-white/10',
  },
  info: {
    row: 'bg-info/12 ring-info/30',
    chipActive: 'bg-gradient-to-br from-info to-info/55 text-white shadow-lg shadow-info/40 ring-1 ring-white/15',
    chipIdle: 'bg-gradient-to-br from-info to-info/55 text-white shadow-md shadow-info/25 ring-1 ring-white/10',
  },
  keep: {
    row: 'bg-success/12 ring-success/30',
    chipActive: 'bg-gradient-to-br from-success to-success/55 text-white shadow-lg shadow-success/40 ring-1 ring-white/15',
    chipIdle: 'bg-gradient-to-br from-success to-success/55 text-white shadow-md shadow-success/25 ring-1 ring-white/10',
  },
  review: {
    row: 'bg-warning/12 ring-warning/30',
    chipActive: 'bg-gradient-to-br from-warning to-warning/55 text-white shadow-lg shadow-warning/40 ring-1 ring-white/15',
    chipIdle: 'bg-gradient-to-br from-warning to-warning/55 text-white shadow-md shadow-warning/25 ring-1 ring-white/10',
  },
};

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isAuthRoute = pathname?.startsWith('/auth');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isAuthRoute) {
      setReady(true);
      return;
    }
    if (!getToken()) {
      router.replace('/auth/login');
      return;
    }
    setReady(true);
  }, [isAuthRoute, router]);

  if (isAuthRoute) {
    return <>{children}</>;
  }

  if (!ready) {
    return <ShellSkeleton />;
  }

  return (
    <ConnectedAccountsProvider>
      <ActiveWorkspaceProvider>
        <ActiveSpaceProvider>
          <ProductChrome>{children}</ProductChrome>
        </ActiveSpaceProvider>
      </ActiveWorkspaceProvider>
    </ConnectedAccountsProvider>
  );
}

function ProductChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const { agentsPaused, setPaused } = useAgentControls();
  const agentPending = useAgentInboxPendingCount();

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-surface-base text-primary">
      <div className="flex min-h-screen">
        <aside
          className={cn(
            'hidden shrink-0 border-r border-subtle bg-surface-base/92 backdrop-blur md:block',
            'transition-[width] duration-token ease-token',
            sidebarExpanded ? 'w-[220px]' : 'w-[60px]',
          )}
        >
          <Sidebar
            expanded={sidebarExpanded}
            pendingCount={agentPending}
            onToggle={() => setSidebarExpanded((value) => !value)}
          />
        </aside>

        {drawerOpen && (
          <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="relative z-10 h-full w-[280px]">
              <Sidebar expanded mobile pendingCount={agentPending} onToggle={() => setDrawerOpen(false)} />
            </div>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <Topbar
            onOpenMenu={() => setDrawerOpen(true)}
            onToggleRail={() => setRailOpen((value) => !value)}
            railOpen={railOpen}
            agentsPaused={agentsPaused}
            onTogglePause={() => setPaused(!agentsPaused)}
            onSignOut={() => {
              clearSession();
              router.replace('/auth/login');
            }}
          />

          <main className="px-4 pb-10 pt-5 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>

        {railOpen && (
          <aside className="hidden w-[320px] shrink-0 border-l border-subtle bg-surface-base/88 backdrop-blur xl:block">
            <AgentRail paused={agentsPaused} onPause={() => setPaused(true)} />
          </aside>
        )}
      </div>
    </div>
  );
}

function Sidebar({
  expanded,
  mobile,
  pendingCount = 0,
  onToggle,
}: {
  expanded: boolean;
  mobile?: boolean;
  pendingCount?: number;
  onToggle: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-surface-base">
      <div className="flex h-16 items-center gap-3 border-b border-subtle px-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-token-lg bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-sm font-semibold text-accent-contrast shadow-lg shadow-accent/40 ring-1 ring-white/15">
          EO
        </div>
        {expanded && (
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-primary">Email-Ops</div>
            <div className="text-[11px] text-tertiary">Cleaner cockpit</div>
          </div>
        )}
        <button
          type="button"
          aria-label={mobile ? 'Close navigation' : expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={onToggle}
          className="ml-auto grid h-8 w-8 place-items-center rounded-token text-tertiary transition hover:bg-surface-overlay hover:text-primary"
        >
          <Icon name={mobile ? 'menu' : 'shield'} />
        </button>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          const badgeCount = item.href === '/agent-inbox' ? pendingCount : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex min-h-[44px] items-center gap-3 rounded-token px-2.5 text-sm transition-colors duration-fast ease-token',
                active
                  ? cn('text-primary ring-1', NAV_TONE[item.tone].row)
                  : 'text-secondary hover:bg-surface-raised hover:text-primary',
                !expanded && 'justify-center px-0',
              )}
              title={expanded ? undefined : item.label}
            >
              <span
                className={cn(
                  'relative grid h-8 w-8 shrink-0 place-items-center rounded-token transition-colors duration-fast',
                  active ? NAV_TONE[item.tone].chipActive : NAV_TONE[item.tone].chipIdle,
                )}
              >
                <Icon name={item.icon} />
                {!expanded && badgeCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-surface-base" />
                )}
              </span>
              {expanded && (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.label}</span>
                    <span className="block truncate text-[11px] text-tertiary">{item.eyebrow}</span>
                  </span>
                  {badgeCount > 0 && (
                    <Badge variant="review" className="shrink-0 font-mono">
                      {badgeCount}
                    </Badge>
                  )}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-subtle p-2">
        <Card className={cn('overflow-hidden', !expanded && 'p-0')}>
          <div className={cn('p-3', !expanded && 'grid place-items-center p-2')}>
            <span className="grid h-8 w-8 place-items-center rounded-token bg-gradient-to-br from-info to-info/55 text-white shadow-md shadow-info/25 ring-1 ring-white/10">
              <Icon name="shield" />
            </span>
            {expanded && (
              <div className="mt-3">
                <p className="text-xs font-medium text-primary">Scope boundary</p>
                <p className="mt-1 text-[11px] leading-4 text-tertiary">
                  Agents stage; you approve. Trash is reversible — permanent purge stays gated
                  behind a downloadable backup.
                </p>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Topbar({
  onOpenMenu,
  onToggleRail,
  railOpen,
  agentsPaused,
  onTogglePause,
  onSignOut,
}: {
  onOpenMenu: () => void;
  onToggleRail: () => void;
  railOpen: boolean;
  agentsPaused: boolean;
  onTogglePause: () => void;
  onSignOut: () => void;
}) {
  const { accounts, activeProvider, setActiveProvider, loading } = useConnectedAccounts();
  const activeMeta = providerMeta(activeProvider);
  const user = getStoredUser<EmailOpsUser>();

  return (
    <header className="sticky top-0 z-30 border-b border-subtle bg-surface-base/92 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-3 sm:px-4 lg:px-6">
        <button
          type="button"
          aria-label="Open navigation"
          className="grid h-10 w-10 place-items-center rounded-token text-secondary transition hover:bg-surface-raised hover:text-primary md:hidden"
          onClick={onOpenMenu}
        >
          <Icon name="menu" />
        </button>

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
          <div className="hidden rounded-token border border-subtle bg-surface-raised px-2.5 py-1.5 text-xs text-tertiary lg:block">
            Cmd+K
          </div>
          <ThemeToggle />
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
          <Button variant="ghost" size="sm" onClick={onToggleRail} className="hidden xl:inline-flex">
            {railOpen ? 'Hide rail' : 'Show rail'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
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

function Icon({ name }: { name: IconName }) {
  const path = {
    dashboard: (
      <>
        <path d="M4 11.5 12 5l8 6.5" />
        <path d="M6 10.5V19h4v-5h4v5h4v-8.5" />
      </>
    ),
    accounts: (
      <>
        <rect x="4" y="5" width="16" height="14" rx="2" />
        <path d="M7 9h10M7 13h6M16 17h1" />
      </>
    ),
    insights: (
      <>
        <path d="M4 19V5" />
        <path d="M8 19V9" />
        <path d="M12 19V7" />
        <path d="M16 19v-5" />
        <path d="M20 19V3" />
      </>
    ),
    cleanup: (
      <>
        <path d="M4 6h16" />
        <path d="M9 6V4h6v2" />
        <path d="M6 6l1 13h10l1-13" />
        <path d="M10 10v6" />
        <path d="M14 10v6" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3 19 6v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6l7-3Z" />
        <path d="m9 12 2 2 4-5" />
      </>
    ),
    activity: (
      <>
        <path d="M4 12h4l2-7 4 14 2-7h4" />
      </>
    ),
    menu: (
      <>
        <path d="M4 7h16" />
        <path d="M4 12h16" />
        <path d="M4 17h16" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>
    ),
  } satisfies Record<IconName, ReactNode>;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {path[name]}
    </svg>
  );
}
