'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, Button, Card, Skeleton, SkeletonText, cn } from '@/components/ui';
import { useConnectedAccounts } from '@/components/ConnectedAccountsProvider';
import { useInboxStats } from '@/components/useInboxStats';
import {
  estimateReclaimableBytes,
  formatBytes,
  formatCount,
  providerMeta,
  storagePercent,
} from '@/lib/cleaner-model';

export default function DashboardPage() {
  const { activeAccount, activeProvider } = useConnectedAccounts();
  const { load, stats, unavailableReason, error, refresh } = useInboxStats(
    activeProvider,
    activeAccount.linked,
  );
  const meta = providerMeta(activeProvider);
  const reclaimable = estimateReclaimableBytes(stats);
  const percent = storagePercent(stats);

  return (
    <div className="space-y-7">
      <header className="relative overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_0%,rgb(var(--accent-2)/0.20),transparent_55%),radial-gradient(95%_130%_at_0%_100%,rgb(var(--accent)/0.18),transparent_55%),radial-gradient(80%_90%_at_50%_120%,rgb(var(--info)/0.12),transparent_60%)]" />
        <div className="relative p-5 sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={activeAccount.linked ? 'success' : 'warning'} dot>
                  {activeAccount.linked ? 'broker linked' : 'connect needed'}
                </Badge>
                <Badge variant="protected">metadata only</Badge>
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
                Overview
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
                A read-only snapshot of your {meta.mailboxLabel.toLowerCase()} — storage, unread,
                and the items that need you. Nothing on this screen sends or deletes; actions live
                in Cleanup and the Agent Inbox.
              </p>
              {unavailableReason && <p className="mt-3 text-xs text-warning">{unavailableReason}</p>}
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row lg:items-center">
              <Button variant="secondary" onClick={() => void refresh()} disabled={load === 'loading'}>
                Refresh stats
              </Button>
              <Link href="/insights?scan=1" className="block">
                <Button block disabled={!activeAccount.linked}>
                  Analyze now
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_1fr_1fr_1fr]">
        <StorageDonut loading={load === 'loading'} percent={percent} stats={stats} />
        <MetricCard
          label="Total"
          value={formatCount(stats?.total_messages)}
          loading={load === 'loading'}
          tone="total"
          icon={<DuoIcon name="inbox" />}
        />
        <MetricCard
          label="Unread"
          value={formatCount(stats?.unread_count)}
          loading={load === 'loading'}
          tone="review"
          icon={<DuoIcon name="unread" />}
        />
        <MetricCard
          label="Reclaimable"
          value={`~${formatBytes(reclaimable)}`}
          loading={load === 'loading'}
          tone="keep"
          icon={<DuoIcon name="sparkle" />}
          caption="Estimate from low-value categories."
        />
      </section>

      <NeedsYouQueue
        linked={activeAccount.linked}
        loading={load === 'loading'}
        stats={stats}
        unavailableReason={unavailableReason}
      />
    </div>
  );
}

type MetricTone = 'total' | 'review' | 'keep';

const METRIC_TONE: Record<
  MetricTone,
  { chip: string; glow: string; num: string; bar: string; ring: string }
> = {
  total: {
    chip: 'bg-gradient-to-br from-info to-info/55 text-white shadow-lg shadow-info/30 ring-1 ring-white/15',
    glow: 'bg-info',
    num: 'text-info',
    bar: 'from-info/80',
    ring: 'ring-info/15',
  },
  review: {
    chip: 'bg-gradient-to-br from-warning to-warning/55 text-white shadow-lg shadow-warning/30 ring-1 ring-white/15',
    glow: 'bg-warning',
    num: 'text-review',
    bar: 'from-warning/80',
    ring: 'ring-warning/15',
  },
  keep: {
    chip: 'bg-gradient-to-br from-success to-success/55 text-white shadow-lg shadow-success/30 ring-1 ring-white/15',
    glow: 'bg-success',
    num: 'text-keep',
    bar: 'from-success/80',
    ring: 'ring-success/15',
  },
};

function StorageDonut({
  loading,
  percent,
  stats,
}: {
  loading: boolean;
  percent: number;
  stats: ReturnType<typeof useInboxStats>['stats'];
}) {
  const circumference = 2 * Math.PI * 44;
  const dash = (percent / 100) * circumference;

  return (
    <Card padded className="relative min-h-[168px] overflow-hidden ring-1 ring-accent/15">
      <div className="pointer-events-none absolute -left-12 -top-12 h-36 w-36 rounded-full bg-accent opacity-25 blur-2xl" />
      {loading ? (
        <div className="flex items-center gap-4">
          <Skeleton circle w={104} h={104} />
          <SkeletonText lines={3} className="flex-1" />
        </div>
      ) : (
        <div className="relative flex items-center gap-4">
          <div className="relative h-[112px] w-[112px]">
            <svg viewBox="0 0 112 112" className="-rotate-90">
              <defs>
                <linearGradient id="eo-donut" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="rgb(var(--accent))" />
                  <stop offset="55%" stopColor="rgb(var(--protected))" />
                  <stop offset="100%" stopColor="rgb(var(--success))" />
                </linearGradient>
              </defs>
              <circle cx="56" cy="56" r="44" fill="none" stroke="rgb(var(--surface-overlay))" strokeWidth="12" />
              <circle
                cx="56"
                cy="56"
                r="44"
                fill="none"
                stroke="url(#eo-donut)"
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={`${dash} ${circumference - dash}`}
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center text-center">
              <span className="font-mono text-xl font-semibold text-primary">{percent}%</span>
            </div>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-token-lg bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-white shadow-lg shadow-accent/30 ring-1 ring-white/15">
                <DuoIcon name="storage" />
              </span>
              <p className="text-sm font-semibold text-primary">Storage</p>
            </div>
            <p className="mt-2 font-mono text-sm text-secondary">
              {formatBytes(stats?.storage_used_bytes)} used
            </p>
            <p className="mt-1 font-mono text-xs text-tertiary">
              {stats?.storage_limit_bytes
                ? `${formatBytes(stats.storage_limit_bytes)} limit`
                : 'limit unknown'}
            </p>
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r from-accent/80 via-protected/50 to-transparent" />
    </Card>
  );
}

function MetricCard({
  label,
  value,
  loading,
  tone,
  caption,
  icon,
}: {
  label: string;
  value: string;
  loading: boolean;
  tone: MetricTone;
  caption?: string;
  icon: ReactNode;
}) {
  const t = METRIC_TONE[tone];
  return (
    <Card padded className={cn('relative min-h-[168px] overflow-hidden ring-1', t.ring)}>
      <div className={cn('pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full opacity-25 blur-2xl', t.glow)} />
      {loading ? (
        <div className="space-y-5">
          <Skeleton w="42%" h={12} />
          <Skeleton w="70%" h={40} />
          <Skeleton w="54%" h={10} />
        </div>
      ) : (
        <div className="relative">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-tertiary">{label}</p>
            <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-token-lg', t.chip)}>
              {icon}
            </span>
          </div>
          <p className={cn('mt-4 font-mono text-4xl font-semibold tracking-[-0.02em]', t.num)}>
            {value}
          </p>
          <p className="mt-3 text-xs leading-5 text-tertiary">
            {caption ?? 'Updated from get_inbox_stats.'}
          </p>
        </div>
      )}
      <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-gradient-to-r to-transparent', t.bar)} />
    </Card>
  );
}

type QueueTone = 'warning' | 'review' | 'accent' | 'info';

const QUEUE_TONE: Record<
  QueueTone,
  { chip: string; edge: string; dot: string; badge: 'warning' | 'review' | 'accent' | 'info' }
> = {
  warning: {
    chip: 'bg-gradient-to-br from-warning to-warning/55 text-white shadow-lg shadow-warning/30 ring-1 ring-white/15',
    edge: 'before:bg-warning',
    dot: 'bg-warning',
    badge: 'warning',
  },
  review: {
    chip: 'bg-gradient-to-br from-review to-review/55 text-white shadow-lg shadow-review/30 ring-1 ring-white/15',
    edge: 'before:bg-review',
    dot: 'bg-review',
    badge: 'review',
  },
  accent: {
    chip: 'bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-white shadow-lg shadow-accent/30 ring-1 ring-white/15',
    edge: 'before:bg-accent',
    dot: 'bg-accent',
    badge: 'accent',
  },
  info: {
    chip: 'bg-gradient-to-br from-info to-info/55 text-white shadow-lg shadow-info/30 ring-1 ring-white/15',
    edge: 'before:bg-info',
    dot: 'bg-info',
    badge: 'info',
  },
};

function NeedsYouQueue({
  linked,
  loading,
  stats,
  unavailableReason,
}: {
  linked: boolean;
  loading: boolean;
  stats: ReturnType<typeof useInboxStats>['stats'];
  unavailableReason: string | null;
}) {
  type QueueItem = {
    tone: QueueTone;
    glyph: 'plug' | 'unread' | 'tag' | 'alert';
    title: string;
    subtitle: string;
    count: string;
    href: string;
    rows: string[];
  };

  const candidates: Array<QueueItem | null> = [
    !linked
      ? {
          tone: 'warning',
          glyph: 'plug',
          title: 'Connect a provider mailbox',
          subtitle: 'Broker sign-in is required before any scan starts.',
          count: '1',
          href: '/accounts',
          rows: ['Scopes are shown before fetch.', 'No message content is read.'],
        }
      : null,
    linked && stats && stats.unread_count > 0
      ? {
          tone: 'review',
          glyph: 'unread',
          title: 'Unread pile needs a look',
          subtitle: `${formatCount(stats.unread_count)} unread messages are visible in stats.`,
          count: formatCount(stats.unread_count),
          href: '/cleanup',
          rows: ['Analyze metadata first.', 'Forward action: Review these.'],
        }
      : null,
    linked && stats && (stats.promotional_count > 0 || stats.social_count > 0)
      ? {
          tone: 'accent',
          glyph: 'tag',
          title: 'Low-value categories found',
          subtitle: 'Promotional and social clusters may reclaim storage.',
          count: formatCount(stats.promotional_count + stats.social_count),
          href: '/cleanup',
          rows: ['No delete action here.', 'Safety Workbench comes later.'],
        }
      : null,
    linked && unavailableReason
      ? {
          tone: 'warning',
          glyph: 'alert',
          title: 'Stats unavailable',
          subtitle: unavailableReason,
          count: '!',
          href: '/accounts',
          rows: ['Reconnect through the broker.', 'The cleaner engine may be dormant.'],
        }
      : null,
  ];
  const items = candidates.filter((item): item is QueueItem => item !== null);

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-tertiary">Needs-you</h2>
        {!loading && items.length > 0 && (
          <span className="font-mono text-xs text-muted">{items.length} open</span>
        )}
      </div>

      {loading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} padded>
              <div className="flex items-center gap-3">
                <Skeleton w={40} h={40} />
                <SkeletonText lines={2} className="flex-1" />
                <Skeleton w={32} h={22} />
              </div>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <AllClear />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((item) => (
            <QueueCard key={item.title} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function QueueCard({
  item,
}: {
  item: {
    tone: QueueTone;
    glyph: 'plug' | 'unread' | 'tag' | 'alert';
    title: string;
    subtitle: string;
    count: string;
    href: string;
    rows: string[];
  };
}) {
  const t = QUEUE_TONE[item.tone];
  return (
    <Card
      interactive
      className={cn(
        'group relative overflow-hidden pl-1',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[""]',
        t.edge,
      )}
    >
      <Link href={item.href} className="block p-4">
        <div className="flex items-start gap-3">
          <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-token-lg', t.chip)}>
            <DuoIcon name={item.glyph} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-primary">{item.title}</p>
            <p className="mt-1 text-xs leading-5 text-tertiary">{item.subtitle}</p>
          </div>
          <Badge variant={t.badge} className="font-mono">
            {item.count}
          </Badge>
        </div>
      </Link>
      <div className="border-t border-subtle">
        {item.rows.map((row) => (
          <div key={row} className="flex items-center gap-2 px-4 py-2 text-xs text-secondary">
            <span className={cn('h-1.5 w-1.5 rounded-full opacity-80', t.dot)} />
            {row}
          </div>
        ))}
        <Link
          href={item.href}
          className="block border-t border-subtle px-4 py-2 text-xs font-medium text-accent transition hover:bg-surface-overlay"
        >
          Open context
        </Link>
      </div>
    </Card>
  );
}

function AllClear() {
  return (
    <Card padded className="overflow-hidden border-success/30 bg-success-subtle ring-1 ring-success/20">
      <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-4">
          <div className="relative grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-success/30 to-success/5 text-success ring-1 ring-success/30">
            <span className="absolute h-20 w-20 rounded-full border border-success/20" />
            <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <div>
            <p className="text-base font-semibold text-primary">Inbox&apos;s clean. Nothing needs you.</p>
            <p className="mt-1 text-sm text-tertiary">
              Last sweep freed estimated storage safely. Run analysis again when you want a fresh
              read-only scan.
            </p>
          </div>
        </div>
        <Link href="/insights?scan=1">
          <Button variant="ghost">Analyze again</Button>
        </Link>
      </div>
    </Card>
  );
}

/**
 * Duotone glyphs: a soft color-filled body + a crisp outline + a bright accent,
 * so each icon reads clearly as the thing it represents and carries real color.
 */
function DuoIcon({ name }: { name: 'inbox' | 'unread' | 'sparkle' | 'storage' | 'plug' | 'tag' | 'alert' }) {
  const body: Record<typeof name, ReactNode> = {
    inbox: (
      <>
        <path
          d="M3 13v3.5A2.5 2.5 0 0 0 5.5 19h13a2.5 2.5 0 0 0 2.5-2.5V13h-4.6a3 3 0 0 1-5.8 0H3Z"
          fill="currentColor"
          fillOpacity="0.22"
          stroke="none"
        />
        <path d="M3 13l2-8h14l2 8" />
        <path d="M3 13h5.2a3 3 0 0 0 5.8 0H21" />
        <path d="M3 13v3.5A2.5 2.5 0 0 0 5.5 19h13a2.5 2.5 0 0 0 2.5-2.5V13" />
      </>
    ),
    unread: (
      <>
        <rect x="3" y="6.5" width="13.5" height="11.5" rx="2.5" fill="currentColor" fillOpacity="0.16" stroke="currentColor" />
        <path d="M3.6 8.4 9.8 12.6 13 10.4" />
        <circle cx="18.5" cy="6.5" r="3.4" fill="currentColor" stroke="none" />
      </>
    ),
    sparkle: (
      <>
        <path
          d="M11 3.4l1.8 5.3 5.3 1.8-5.3 1.8L11 17.6l-1.8-5.3L3.9 10.5l5.3-1.8Z"
          fill="currentColor"
          fillOpacity="0.2"
          stroke="currentColor"
        />
        <path d="M18 14l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7Z" fill="currentColor" stroke="none" />
      </>
    ),
    storage: (
      <>
        <ellipse cx="12" cy="6" rx="7" ry="3" fill="currentColor" fillOpacity="0.2" stroke="currentColor" />
        <path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
        <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
      </>
    ),
    plug: (
      <>
        <path d="M6.5 9h11v1.5a5.5 5.5 0 0 1-11 0V9Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" />
        <path d="M9 9V3.8M15 9V3.8M12 16v4.2" />
      </>
    ),
    tag: (
      <>
        <path
          d="M4 5.4 11 5l8.4 8.4a2 2 0 0 1 0 2.8l-4.2 4.2a2 2 0 0 1-2.8 0L4 12V5.4Z"
          fill="currentColor"
          fillOpacity="0.18"
          stroke="currentColor"
        />
        <circle cx="8.2" cy="8.8" r="1.5" fill="currentColor" stroke="none" />
      </>
    ),
    alert: (
      <>
        <path d="M12 4 2.7 20.5h18.6Z" fill="currentColor" fillOpacity="0.18" stroke="currentColor" />
        <path d="M12 10.5v4.2" />
        <circle cx="12" cy="17.6" r="0.7" fill="currentColor" stroke="none" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body[name]}
    </svg>
  );
}
