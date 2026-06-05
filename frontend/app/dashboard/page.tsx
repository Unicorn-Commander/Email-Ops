'use client';

import Link from 'next/link';
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
      <header className="overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
        <div className="relative p-5 sm:p-6">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgb(var(--accent)/0.20),transparent_26rem)]" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={activeAccount.linked ? 'success' : 'warning'} dot>
                  {activeAccount.linked ? 'broker linked' : 'connect needed'}
                </Badge>
                <Badge variant="protected">metadata only</Badge>
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
                Calm control for {meta.mailboxLabel.toLowerCase()}.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
                Read-only stats, prioritized needs-you signals, and no cleanup controls on this
                screen. Review comes before every write.
              </p>
              {unavailableReason && (
                <p className="mt-3 text-xs text-warning">{unavailableReason}</p>
              )}
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
        <MetricCard label="Total" value={formatCount(stats?.total_messages)} loading={load === 'loading'} />
        <MetricCard label="Unread" value={formatCount(stats?.unread_count)} loading={load === 'loading'} tone="review" />
        <MetricCard
          label="Reclaimable"
          value={`~${formatBytes(reclaimable)}`}
          loading={load === 'loading'}
          tone="keep"
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
    <Card padded className="min-h-[168px] overflow-hidden">
      {loading ? (
        <div className="flex items-center gap-4">
          <Skeleton circle w={104} h={104} />
          <SkeletonText lines={3} className="flex-1" />
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <div className="relative h-[112px] w-[112px]">
            <svg viewBox="0 0 112 112" className="-rotate-90">
              <circle
                cx="56"
                cy="56"
                r="44"
                fill="none"
                stroke="rgb(var(--surface-overlay))"
                strokeWidth="12"
              />
              <circle
                cx="56"
                cy="56"
                r="44"
                fill="none"
                stroke="rgb(var(--accent))"
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
            <p className="text-sm font-semibold text-primary">Storage</p>
            <p className="mt-2 font-mono text-sm text-secondary">
              {formatBytes(stats?.storage_used_bytes)} used
            </p>
            <p className="mt-1 font-mono text-xs text-tertiary">
              {stats?.storage_limit_bytes ? `${formatBytes(stats.storage_limit_bytes)} limit` : 'limit unknown'}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

function MetricCard({
  label,
  value,
  loading,
  tone = 'accent',
  caption,
}: {
  label: string;
  value: string;
  loading: boolean;
  tone?: 'accent' | 'keep' | 'review';
  caption?: string;
}) {
  return (
    <Card padded className="min-h-[168px]">
      {loading ? (
        <div className="space-y-5">
          <Skeleton w="42%" h={12} />
          <Skeleton w="70%" h={40} />
          <Skeleton w="54%" h={10} />
        </div>
      ) : (
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-tertiary">{label}</p>
          <p
            className={cn(
              'mt-5 font-mono text-4xl font-semibold tracking-[-0.02em]',
              tone === 'keep' ? 'text-keep' : tone === 'review' ? 'text-review' : 'text-primary',
            )}
          >
            {value}
          </p>
          <p className="mt-4 text-xs leading-5 text-tertiary">
            {caption ?? 'Updated from get_inbox_stats.'}
          </p>
        </div>
      )}
    </Card>
  );
}

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
    tone: 'warning' | 'review' | 'accent';
    title: string;
    subtitle: string;
    count: string;
    href: string;
    rows: string[];
  };

  const candidates: Array<QueueItem | null> = [
    !linked
      ? {
          tone: 'warning' as const,
          title: 'Connect a provider mailbox',
          subtitle: 'Broker sign-in is required before any scan starts.',
          count: '1',
          href: '/accounts',
          rows: ['Scopes are shown before fetch.', 'No message content is read.'],
        }
      : null,
    linked && stats && stats.unread_count > 0
      ? {
          tone: 'review' as const,
          title: 'Unread pile needs a look',
          subtitle: `${formatCount(stats.unread_count)} unread messages are visible in stats.`,
          count: formatCount(stats.unread_count),
          href: '/insights',
          rows: ['Analyze metadata first.', 'Forward action: Review these.'],
        }
      : null,
    linked && stats && (stats.promotional_count > 0 || stats.social_count > 0)
      ? {
          tone: 'accent' as const,
          title: 'Low-value categories found',
          subtitle: 'Promotional and social clusters may reclaim storage.',
          count: formatCount(stats.promotional_count + stats.social_count),
          href: '/insights',
          rows: ['No delete action here.', 'Safety Workbench comes later.'],
        }
      : null,
    linked && unavailableReason
      ? {
          tone: 'warning' as const,
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
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-tertiary">
          Needs-you
        </h2>
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
    tone: 'warning' | 'review' | 'accent';
    title: string;
    subtitle: string;
    count: string;
    href: string;
    rows: string[];
  };
}) {
  const variant = item.tone === 'warning' || item.tone === 'review' ? 'warning' : 'accent';
  return (
    <Card interactive className="group overflow-hidden">
      <Link href={item.href} className="block p-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'grid h-10 w-10 shrink-0 place-items-center rounded-token',
              item.tone === 'accent'
                ? 'bg-accent/15 text-accent'
                : 'bg-warning-subtle text-warning',
            )}
          >
            <span className="h-2 w-2 rounded-full bg-current" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-primary">{item.title}</p>
            <p className="mt-1 text-xs leading-5 text-tertiary">{item.subtitle}</p>
          </div>
          <Badge variant={variant} className="font-mono">
            {item.count}
          </Badge>
        </div>
      </Link>
      <div className="border-t border-subtle">
        {item.rows.map((row) => (
          <div key={row} className="flex items-center gap-2 px-4 py-2 text-xs text-secondary">
            <span className="h-1.5 w-1.5 rounded-full bg-tertiary/50" />
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
    <Card padded className="overflow-hidden border-success/30 bg-success-subtle">
      <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-4">
          <div className="relative grid h-14 w-14 shrink-0 place-items-center rounded-full bg-success/15 text-success">
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
