import type { ConnectedProvider, EngineInboxStats, LinkedAccountView } from './api';

export const PROVIDERS: ConnectedProvider[] = ['gmail', 'microsoft'];

export interface ProviderMeta {
  provider: ConnectedProvider;
  label: string;
  shortLabel: string;
  mailboxLabel: string;
  brokerLabel: string;
  accentClass: string;
  initial: string;
}

export const PROVIDER_META: Record<ConnectedProvider, ProviderMeta> = {
  gmail: {
    provider: 'gmail',
    label: 'Gmail',
    shortLabel: 'Gmail',
    mailboxLabel: 'Gmail mailbox',
    brokerLabel: 'Google broker sign-in',
    accentClass: 'from-danger/30 via-warning/20 to-accent/20',
    initial: 'G',
  },
  microsoft: {
    provider: 'microsoft',
    label: 'Microsoft 365',
    shortLabel: 'M365',
    mailboxLabel: 'Microsoft mailbox',
    brokerLabel: 'Microsoft broker sign-in',
    accentClass: 'from-info/30 via-accent/18 to-success/16',
    initial: 'M',
  },
};

export function providerMeta(provider: ConnectedProvider): ProviderMeta {
  return PROVIDER_META[provider];
}

export function normalizedAccounts(accounts: LinkedAccountView[]): LinkedAccountView[] {
  const byProvider = new Map(accounts.map((account) => [account.provider, account]));
  return PROVIDERS.map((provider) => byProvider.get(provider) ?? { provider, linked: false });
}

export function formatCount(n: number | null | undefined): string {
  if (!Number.isFinite(n ?? NaN)) return '0';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n ?? 0);
}

export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let next = value;
  let idx = 0;
  while (next >= 1024 && idx < units.length - 1) {
    next /= 1024;
    idx += 1;
  }
  return `${next >= 10 || idx === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[idx]}`;
}

export function storagePercent(stats: EngineInboxStats | null | undefined): number {
  if (!stats?.storage_limit_bytes) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((stats.storage_used_bytes / stats.storage_limit_bytes) * 100)),
  );
}

export function estimateReclaimableBytes(stats: EngineInboxStats | null | undefined): number {
  if (!stats) return 0;
  const used = Number(stats.storage_used_bytes ?? 0);
  if (!Number.isFinite(used) || used <= 0) return 0;
  const total = Math.max(1, Number(stats.total_messages ?? 0));
  const lowValueCount = Number(stats.promotional_count ?? 0) + Number(stats.social_count ?? 0);
  const ratio = Math.max(0.08, Math.min(0.42, lowValueCount / total));
  return Math.round(used * ratio);
}

export interface BarDatum {
  label: string;
  count: number;
}

export interface FrequencyRow {
  label: string;
  count: number;
}

export interface Recommendation {
  title: string;
  body: string;
  confidence: 'high' | 'medium' | 'low';
  estimate?: number;
}

export interface AnalysisViewModel {
  totalMessages: number;
  categories: BarDatum[];
  topSenders: FrequencyRow[];
  topDomains: FrequencyRow[];
  ageBuckets: BarDatum[];
  sizeBuckets: BarDatum[];
  unreadCount: number;
  aiCategories: string[];
  recommendations: Recommendation[];
  aiUnavailable: boolean;
}

export function analysisViewModel(
  analysis: Record<string, unknown> | null | undefined,
  stats: EngineInboxStats | null | undefined,
): AnalysisViewModel {
  const senderFrequency = record(analysis?.sender_frequency);
  const categories = record(analysis?.categories);
  const ageDistribution = record(analysis?.age_distribution);
  const sizeDistribution = record(analysis?.size_distribution);

  return {
    totalMessages: numberValue(analysis?.total_messages, stats?.total_messages ?? 0),
    categories: categoryBars(categories, stats),
    topSenders: topRows(senderFrequency.top_senders, 'sender'),
    topDomains: topRows(senderFrequency.top_domains, 'domain'),
    ageBuckets: bucketBars(record(ageDistribution.buckets), [
      ['past_week', 'Past week'],
      ['past_month', 'Past month'],
      ['past_quarter', 'Past quarter'],
      ['past_year', 'Past year'],
      ['older', 'Older'],
    ]),
    sizeBuckets: bucketBars(record(sizeDistribution.buckets), [
      ['tiny', 'Tiny'],
      ['small', 'Small'],
      ['medium', 'Medium'],
      ['large', 'Large'],
      ['huge', 'Huge'],
    ]),
    unreadCount: numberValue(categories.unread_count, stats?.unread_count ?? 0),
    aiCategories: aiCategoryLabels(analysis?.ai_categories),
    recommendations: recommendations(analysis?.recommendations),
    aiUnavailable:
      analysis?.ai_status === 'ai_unavailable' ||
      (!arrayValue(analysis?.ai_categories).length && !arrayValue(analysis?.recommendations).length),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function categoryBars(
  categories: Record<string, unknown>,
  stats: EngineInboxStats | null | undefined,
): BarDatum[] {
  const byLabel = record(categories.by_label);
  const bars = Object.entries(byLabel)
    .map(([label, count]) => ({
      label: label.replace(/^CATEGORY_/, '').replaceAll('_', ' ').toLowerCase(),
      count: numberValue(count),
    }))
    .filter((bar) => bar.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  if (bars.length > 0) return bars;

  return [
    { label: 'Promotional', count: Number(stats?.promotional_count ?? 0) },
    { label: 'Social', count: Number(stats?.social_count ?? 0) },
    { label: 'Unread', count: Number(stats?.unread_count ?? 0) },
  ].filter((bar) => bar.count > 0);
}

function topRows(value: unknown, key: 'sender' | 'domain'): FrequencyRow[] {
  return arrayValue(value)
    .map((row) => record(row))
    .map((row) => ({
      label: String(row[key] ?? ''),
      count: numberValue(row.count),
    }))
    .filter((row) => row.label && row.count > 0)
    .slice(0, 8);
}

function bucketBars(
  buckets: Record<string, unknown>,
  order: Array<[string, string]>,
): BarDatum[] {
  return order.map(([key, label]) => ({ label, count: numberValue(buckets[key]) }));
}

function aiCategoryLabels(value: unknown): string[] {
  return arrayValue(value)
    .map((item) => {
      if (typeof item === 'string') return item;
      const row = record(item);
      return String(row.category ?? row.label ?? row.name ?? '');
    })
    .filter(Boolean)
    .slice(0, 8);
}

function recommendations(value: unknown): Recommendation[] {
  return arrayValue(value)
    .map((item) => {
      const row = record(item);
      const category = String(row.category ?? row.title ?? 'Inbox pattern');
      const reason = String(row.reason ?? row.body ?? 'Review this cluster before taking action.');
      const priority = String(row.priority ?? row.confidence ?? 'medium').toLowerCase();
      const confidence: Recommendation['confidence'] =
        priority === 'high' ? 'high' : priority === 'low' ? 'low' : 'medium';
      return {
        title: titleCase(category),
        body: reason,
        confidence,
        estimate: row.estimated_messages === undefined ? undefined : numberValue(row.estimated_messages),
      };
    })
    .filter((item) => item.title)
    .slice(0, 3);
}

function titleCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}
