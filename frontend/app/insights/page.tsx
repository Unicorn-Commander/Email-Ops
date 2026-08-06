'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, Card, Skeleton, SkeletonText, cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { useConnectedAccounts } from '@/components/ConnectedAccountsProvider';
import { useInboxStats } from '@/components/useInboxStats';
import {
  analysisViewModel,
  formatCount,
  providerMeta,
  type BarDatum,
  type FrequencyRow,
  type Recommendation,
} from '@/lib/cleaner-model';
import { analyzeInbox, ApiError, clearSession } from '@/lib/api';
import Link from 'next/link';

type ScanStage = 'fetch' | 'metadata' | 'analyze' | 'ai' | 'done';
type ScanState = 'idle' | 'running' | 'done' | 'error';

const STAGES: Array<{ key: ScanStage; label: string }> = [
  { key: 'fetch', label: 'Fetch' },
  { key: 'metadata', label: 'Metadata' },
  { key: 'analyze', label: 'Analyze' },
  { key: 'ai', label: 'AI' },
  { key: 'done', label: 'Done' },
];

export default function InsightsPage() {
  return (
    <Suspense fallback={<InsightsSkeleton />}>
      <InsightsContent />
    </Suspense>
  );
}

function InsightsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeAccount, activeProvider } = useConnectedAccounts();
  const { load, stats, unavailableReason, error: statsError, refresh } = useInboxStats(
    activeProvider,
    activeAccount.linked,
  );
  const [analysis, setAnalysis] = useState<Record<string, unknown> | null>(null);
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [stage, setStage] = useState<ScanStage>('fetch');
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const autoRan = useRef(false);
  const meta = providerMeta(activeProvider);

  useEffect(() => {
    setAnalysis(null);
    setScanState('idle');
    setStage('fetch');
    setScanMessage(null);
    autoRan.current = false;
  }, [activeProvider]);

  const runAnalysis = useCallback(async () => {
    if (!activeAccount.linked) {
      setScanMessage('Connect this provider before analysis.');
      return;
    }

    setScanState('running');
    setStage('fetch');
    setScanMessage('Fetching message list from the provider.');
    let stageIndex = 0;
    const timer = window.setInterval(() => {
      stageIndex = Math.min(stageIndex + 1, STAGES.length - 2);
      const next = STAGES[stageIndex]?.key ?? 'ai';
      setStage(next);
      setScanMessage(messageForStage(next));
    }, 1100);

    try {
      await refresh();
      const result = await analyzeInbox(activeProvider);
      if (result.available) {
        setAnalysis(result.analysis);
        setScanState('done');
        setStage('done');
        setScanMessage(
          result.analysis.ai_status === 'ai_unavailable'
            ? 'AI unavailable. Statistical insights are ready.'
            : 'Analysis complete. Review-only insights are ready.',
        );
      } else {
        setAnalysis(null);
        setScanState('done');
        setStage('done');
        setScanMessage(result.reason);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/auth/login');
        return;
      }
      setScanState('error');
      setScanMessage(err instanceof Error ? err.message : 'Could not analyze this inbox.');
    } finally {
      window.clearInterval(timer);
    }
  }, [activeAccount.linked, activeProvider, refresh, router]);

  useEffect(() => {
    if (searchParams.get('scan') === '1' && activeAccount.linked && !autoRan.current) {
      autoRan.current = true;
      void runAnalysis();
    }
  }, [activeAccount.linked, runAnalysis, searchParams]);

  const model = useMemo(() => analysisViewModel(analysis, stats), [analysis, stats]);
  const canAnalyze = activeAccount.linked && scanState !== 'running';

  return (
    <div className="space-y-7">
      <header className="overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
        <div className="relative p-5 sm:p-6">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgb(var(--info)/0.16),transparent_26rem),radial-gradient(circle_at_90%_20%,rgb(var(--accent)/0.14),transparent_24rem)]" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="protected">headers + metadata only</Badge>
                <Badge variant={activeAccount.linked ? 'success' : 'warning'} dot>
                  {activeAccount.linked ? `${meta.shortLabel} linked` : 'connect needed'}
                </Badge>
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
                Inbox Analysis
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
                Category patterns, top senders, age and size distributions, and AI recommendations.
                Every forward action is review-only.
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="secondary" onClick={() => void refresh()} disabled={load === 'loading'}>
                Refresh stats
              </Button>
              <Button onClick={() => void runAnalysis()} disabled={!canAnalyze}>
                {scanState === 'running' ? 'Analyzing...' : 'Analyze now'}
              </Button>
            </div>
          </div>
        </div>
      </header>

      <Card padded className="sticky top-[76px] z-20 border-protected/25 bg-surface-raised/96 backdrop-blur">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-sm text-secondary">
            <span className="font-medium text-primary">Privacy line:</span> Analysis reads headers +
            metadata only, never message content.
          </p>
          <Tooltip
            content={
              model.aiUnavailable
                ? 'The AI layer is unreachable, so this run degraded safely to statistical insights only — nothing failed silently'
                : 'The AI layer is reachable — recommendations and category chips include model output'
            }
            bubbleClassName="max-w-[300px]"
          >
            <span tabIndex={0}>
              <Badge variant={model.aiUnavailable ? 'warning' : 'success'} dot>
                {model.aiUnavailable ? 'AI unavailable-safe' : 'AI ready'}
              </Badge>
            </span>
          </Tooltip>
        </div>
      </Card>

      <SteppedProgress state={scanState} stage={stage} message={scanMessage} />

      {!activeAccount.linked && (
        <Card padded className="border-warning/30 bg-warning-subtle">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-medium text-primary">Connect {meta.label} before scanning.</p>
              <p className="mt-1 text-sm text-tertiary">
                The read surface waits for broker consent. Nothing is fetched until sign-in.
              </p>
            </div>
            <Button onClick={() => router.push('/accounts')}>Open accounts</Button>
          </div>
        </Card>
      )}

      {(statsError || unavailableReason) && activeAccount.linked && (
        <Card padded className="border-warning/30 bg-warning-subtle">
          <p className="text-sm font-medium text-primary">Stats unavailable</p>
          <p className="mt-1 text-sm text-tertiary">{statsError ?? unavailableReason}</p>
        </Card>
      )}

      <section className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <CategoryBars loading={load === 'loading'} data={model.categories} total={model.totalMessages} />
        <UnreadPile loading={load === 'loading'} unread={model.unreadCount} total={model.totalMessages} />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <FrequencyTable title="Top Senders" rows={model.topSenders} label="Sender" />
        <FrequencyTable title="Top Domains" rows={model.topDomains} label="Domain" />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Histogram title="Age Histogram" data={model.ageBuckets} />
        <Histogram title="Size Histogram" data={model.sizeBuckets} actionLabel="Show largest" />
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
        <AiCategoryChips chips={model.aiCategories} unavailable={model.aiUnavailable} />
        <RecommendationCards
          recommendations={model.recommendations}
          unavailable={model.aiUnavailable}
        />
      </section>
    </div>
  );
}

function SteppedProgress({
  state,
  stage,
  message,
}: {
  state: ScanState;
  stage: ScanStage;
  message: string | null;
}) {
  const activeIndex = STAGES.findIndex((item) => item.key === stage);

  return (
    <Card padded>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">
            {state === 'running'
              ? 'Long scan in progress'
              : state === 'done'
                ? 'Latest scan state'
                : state === 'error'
                  ? 'Scan needs attention'
                  : 'Ready for read-only scan'}
          </p>
          <p className="mt-1 text-sm text-tertiary">
            {message ?? 'Fetch -> metadata -> analyze -> ai -> done.'}
          </p>
        </div>
        <div className="grid min-w-0 flex-1 grid-cols-5 gap-2 lg:max-w-xl">
          {STAGES.map((item, index) => {
            const complete = state === 'done' || index < activeIndex;
            const active = state === 'running' && index === activeIndex;
            return (
              <div key={item.key} className="min-w-0">
                <div
                  className={cn(
                    'h-2 rounded-full transition-colors duration-token ease-token',
                    complete
                      ? 'bg-success'
                      : active
                        ? 'bg-accent'
                        : state === 'error' && index === activeIndex
                          ? 'bg-danger'
                          : 'bg-surface-overlay',
                  )}
                />
                <p
                  className={cn(
                    'mt-2 truncate text-[11px]',
                    active ? 'text-accent' : complete ? 'text-success' : 'text-tertiary',
                  )}
                >
                  {item.label}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function CategoryBars({
  loading,
  data,
  total,
}: {
  loading: boolean;
  data: BarDatum[];
  total: number;
}) {
  return (
    <Card padded>
      <SectionHead title="Category Bars" badge={`${formatCount(total)} messages`} hint="How your visible mail splits across provider categories (promotions, social, updates, …) — from headers only" />
      {loading ? (
        <SkeletonText lines={5} className="mt-5" />
      ) : data.length === 0 ? (
        <EmptyLine text="Run analysis to populate category bars." />
      ) : (
        <div className="mt-5 space-y-4">
          {data.map((bar) => (
            <BarRow key={bar.label} bar={bar} max={Math.max(...data.map((item) => item.count), 1)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function UnreadPile({ loading, unread, total }: { loading: boolean; unread: number; total: number }) {
  const ratio = total > 0 ? Math.round((unread / total) * 100) : 0;
  return (
    <Card padded>
      <SectionHead title="Unread Pile" badge="review only" hint="How much of the visible mailbox is unread — a decluttering signal, never an action" />
      {loading ? (
        <div className="mt-5 space-y-4">
          <Skeleton w="60%" h={44} />
          <Skeleton h={84} />
        </div>
      ) : (
        <div className="mt-5">
          <p className="font-mono text-5xl font-semibold tracking-[-0.03em] text-review">
            {formatCount(unread)}
          </p>
          <p className="mt-2 text-sm text-tertiary">{ratio}% of visible messages are unread.</p>
          <div className="mt-5 rounded-token border border-subtle bg-surface-base p-3">
            <p className="text-xs text-secondary">
              Forward action:{' '}
              <Link href="/cleanup" className="font-medium text-accent hover:underline">
                Review these -&gt;
              </Link>
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}

function FrequencyTable({
  title,
  rows,
  label,
}: {
  title: string;
  rows: FrequencyRow[];
  label: string;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-subtle p-4">
        <SectionHead title={title} badge="metadata" hint="Who fills your mailbox most — counts from message headers, ranked highest first" />
      </div>
      {rows.length === 0 ? (
        <div className="p-4">
          <EmptyLine text="Run analysis to reveal the top rows." />
        </div>
      ) : (
        <div className="divide-y divide-subtle">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-primary">{row.label}</p>
                <p className="mt-1 text-[11px] text-tertiary">{label}</p>
              </div>
              <span className="font-mono text-sm text-secondary">{formatCount(row.count)}</span>
              <Link
                href="/cleanup"
                className="rounded-token px-2 py-1 text-xs font-medium text-accent transition hover:bg-surface-overlay"
              >
                Review these -&gt;
              </Link>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Histogram({
  title,
  data,
  actionLabel,
}: {
  title: string;
  data: BarDatum[];
  actionLabel?: string;
}) {
  const max = Math.max(...data.map((item) => item.count), 1);
  return (
    <Card padded>
      <SectionHead title={title} badge={actionLabel ?? 'distribution'} hint="Distribution across buckets — tall bars show where volume (or size) concentrates" />
      <div className="mt-5 flex h-48 items-end gap-3">
        {data.map((bar) => (
          <div key={bar.label} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-2">
            <div
              className="min-h-[8px] rounded-t-token bg-accent/70 transition-[height] duration-token ease-token"
              style={{ height: `${Math.max(4, (bar.count / max) * 100)}%` }}
            />
            <p className="truncate text-center text-[11px] text-tertiary">{bar.label}</p>
            <p className="text-center font-mono text-[11px] text-secondary">{formatCount(bar.count)}</p>
          </div>
        ))}
      </div>
      {actionLabel && (
        <button
          type="button"
          className="mt-4 rounded-token px-2 py-1 text-xs font-medium text-accent transition hover:bg-surface-overlay"
        >
          {actionLabel} -&gt;
        </button>
      )}
    </Card>
  );
}

function AiCategoryChips({
  chips,
  unavailable,
}: {
  chips: string[];
  unavailable: boolean;
}) {
  return (
    <Card padded>
      <SectionHead title="AI Categories" badge={unavailable ? 'degraded' : 'available'} hint="Model-suggested groupings of your mail — degrades to statistics-only when the AI layer is unreachable" />
      {unavailable ? (
        <EmptyLine text="AI unavailable. Statistical insights remain usable." />
      ) : chips.length === 0 ? (
        <EmptyLine text="No AI categories returned yet." />
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <Badge key={chip} variant="info">
              {chip}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

function RecommendationCards({
  recommendations,
  unavailable,
}: {
  recommendations: Recommendation[];
  unavailable: boolean;
}) {
  return (
    <Card padded>
      <SectionHead title="Recommendations" badge="review gate" hint="Suggested cleanups — every one routes through the review workbench; nothing executes from this page" />
      {unavailable ? (
        <div className="mt-5 rounded-token-lg border border-warning/30 bg-warning-subtle p-4">
          <Badge variant="warning" dot>
            AI unavailable
          </Badge>
          <p className="mt-3 text-sm text-primary">The scan completed without AI recommendations.</p>
          <p className="mt-1 text-sm text-tertiary">
            Category bars, sender tables, and histograms are still based on provider metadata.
          </p>
        </div>
      ) : recommendations.length === 0 ? (
        <EmptyLine text="Run analysis to populate recommendation cards." />
      ) : (
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {recommendations.map((recommendation) => (
            <RecommendationCard key={`${recommendation.title}-${recommendation.body}`} item={recommendation} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RecommendationCard({ item }: { item: Recommendation }) {
  const variant =
    item.confidence === 'high' ? 'success' : item.confidence === 'low' ? 'danger' : 'warning';
  return (
    <div className="rounded-token-lg border border-subtle bg-surface-base p-4">
      <Badge variant={variant} dot>
        {item.confidence === 'high'
          ? 'high confidence'
          : item.confidence === 'low'
            ? 'low confidence'
            : 'needs review'}
      </Badge>
      <p className="mt-3 text-sm font-medium text-primary">{item.title}</p>
      <p className="mt-2 text-xs leading-5 text-tertiary">{item.body}</p>
      {item.estimate !== undefined && (
        <p className="mt-3 font-mono text-xs text-secondary">{formatCount(item.estimate)} messages</p>
      )}
      <button
        type="button"
        className="mt-4 rounded-token px-2 py-1 text-xs font-medium text-accent transition hover:bg-surface-overlay"
      >
        Review this plan -&gt;
      </button>
    </div>
  );
}

function BarRow({ bar, max }: { bar: BarDatum; max: number }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="truncate text-sm text-secondary">{bar.label}</span>
        <span className="font-mono text-xs text-tertiary">{formatCount(bar.count)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-overlay">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-token ease-token"
          style={{ width: `${Math.max(4, (bar.count / max) * 100)}%` }}
        />
      </div>
    </div>
  );
}

function SectionHead({ title, badge, hint }: { title: string; badge: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Tooltip content={hint} disabled={!hint} bubbleClassName="max-w-[300px]">
        <h2 className="text-sm font-semibold text-primary" tabIndex={hint ? 0 : undefined}>
          {title}
        </h2>
      </Tooltip>
      <Badge variant="neutral" className="font-mono">
        {badge}
      </Badge>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div className="mt-5 rounded-token border border-subtle bg-surface-base p-4 text-sm text-tertiary">
      {text}
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div className="space-y-4">
      <Card padded>
        <Skeleton w="50%" h={36} />
        <Skeleton w="70%" h={14} className="mt-4" />
      </Card>
      <Card padded>
        <SkeletonText lines={4} />
      </Card>
    </div>
  );
}

function messageForStage(stage: ScanStage): string {
  switch (stage) {
    case 'fetch':
      return 'Fetching message list from the provider.';
    case 'metadata':
      return 'Reading headers, labels, timestamps, sizes, and sender metadata.';
    case 'analyze':
      return 'Building statistical categories and distributions.';
    case 'ai':
      return 'Requesting AI recommendations when available.';
    case 'done':
      return 'Analysis complete.';
  }
}
