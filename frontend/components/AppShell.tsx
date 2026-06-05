'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Badge, Button, Card, Select, Skeleton, cn } from '@/components/ui';
import { ConnectedAccountsProvider, useConnectedAccounts } from './ConnectedAccountsProvider';
import { clearSession, getStoredUser, getToken, type EmailOpsUser } from '@/lib/api';
import { providerMeta } from '@/lib/cleaner-model';

type IconName = 'dashboard' | 'accounts' | 'insights' | 'shield' | 'activity' | 'menu' | 'mail';

const NAV = [
  {
    href: '/dashboard',
    label: 'Overview',
    eyebrow: 'Needs-you',
    icon: 'dashboard' as const,
  },
  {
    href: '/accounts',
    label: 'Accounts',
    eyebrow: 'Broker access',
    icon: 'accounts' as const,
  },
  {
    href: '/insights',
    label: 'Insights',
    eyebrow: 'Read-only scan',
    icon: 'insights' as const,
  },
];

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
      <ProductChrome>{children}</ProductChrome>
    </ConnectedAccountsProvider>
  );
}

function ProductChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [agentsPaused, setAgentsPaused] = useState(false);

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
              <Sidebar expanded mobile onToggle={() => setDrawerOpen(false)} />
            </div>
          </div>
        )}

        <div className="min-w-0 flex-1">
          <Topbar
            onOpenMenu={() => setDrawerOpen(true)}
            onToggleRail={() => setRailOpen((value) => !value)}
            railOpen={railOpen}
            agentsPaused={agentsPaused}
            onTogglePause={() => setAgentsPaused((value) => !value)}
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
            <AgentRail paused={agentsPaused} onPause={() => setAgentsPaused(true)} />
          </aside>
        )}
      </div>
    </div>
  );
}

function Sidebar({
  expanded,
  mobile,
  onToggle,
}: {
  expanded: boolean;
  mobile?: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-surface-base">
      <div className="flex h-16 items-center gap-3 border-b border-subtle px-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-token-lg bg-accent text-sm font-semibold text-accent-contrast shadow-token">
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
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex min-h-[44px] items-center gap-3 rounded-token px-2.5 text-sm transition-colors duration-fast ease-token',
                active
                  ? 'bg-accent/14 text-primary ring-1 ring-accent/25'
                  : 'text-secondary hover:bg-surface-raised hover:text-primary',
                !expanded && 'justify-center px-0',
              )}
              title={expanded ? undefined : item.label}
            >
              <span
                className={cn(
                  'grid h-8 w-8 shrink-0 place-items-center rounded-token',
                  active ? 'bg-accent text-accent-contrast' : 'bg-surface-raised text-tertiary',
                )}
              >
                <Icon name={item.icon} />
              </span>
              {expanded && (
                <span className="min-w-0">
                  <span className="block truncate font-medium">{item.label}</span>
                  <span className="block truncate text-[11px] text-tertiary">{item.eyebrow}</span>
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-subtle p-2">
        <Card className={cn('overflow-hidden', !expanded && 'p-0')}>
          <div className={cn('p-3', !expanded && 'grid place-items-center p-2')}>
            <span className="grid h-8 w-8 place-items-center rounded-token bg-protected-subtle text-protected">
              <Icon name="shield" />
            </span>
            {expanded && (
              <div className="mt-3">
                <p className="text-xs font-medium text-primary">Scope boundary</p>
                <p className="mt-1 text-[11px] leading-4 text-tertiary">
                  Can analyze and stage review. Cannot permanently delete or send.
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
  const linkedCount = accounts.filter((account) => account.linked).length;
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
              <Badge variant={linkedCount > 0 ? 'success' : 'warning'} dot>
                {linkedCount > 0 ? `${linkedCount} linked` : 'connect'}
              </Badge>
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
