/**
 * Honest read-path status for a connected mailbox.
 *
 * An empty thread/message list is NOT proof the mailbox is empty. When the
 * Cleaner engine is unwired, unreachable, or the provider read fails, the
 * backend must return one of the unavailable statuses below so the inbox UI
 * can say so — never a silent empty list.
 *
 * `ok` (or omitted, for older clients) means the read completed: a populated
 * list or a truly empty mailbox.
 */

export const MAIL_READ_STATUSES = [
  'ok',
  'engine_not_configured',
  'engine_unreachable',
  'provider_auth_failed',
  'provider_error',
] as const;

export type MailReadStatus = (typeof MAIL_READ_STATUSES)[number];

export type MailReadUnavailable = Exclude<MailReadStatus, 'ok'>;

const UNAVAILABLE: ReadonlySet<string> = new Set([
  'engine_not_configured',
  'engine_unreachable',
  'provider_auth_failed',
  'provider_error',
]);

/** Most-actionable first: reconnect beats retry, retry beats "service down". */
const UNAVAILABLE_PRIORITY: MailReadUnavailable[] = [
  'provider_auth_failed',
  'provider_error',
  'engine_unreachable',
  'engine_not_configured',
];

export function isMailReadUnavailable(
  status: string | null | undefined,
): status is MailReadUnavailable {
  return typeof status === 'string' && UNAVAILABLE.has(status);
}

export function parseMailReadStatus(raw: unknown): MailReadStatus {
  if (typeof raw === 'string' && (raw === 'ok' || UNAVAILABLE.has(raw))) {
    return raw as MailReadStatus;
  }
  return 'ok';
}

/**
 * Merge per-mailbox statuses for the unified inbox. A mailbox that produced
 * threads keeps the aggregate `ok` (the user can see mail). An empty merge
 * surfaces the most actionable unavailable status so "All inboxes" never looks
 * empty when a connected mailbox could not be read.
 */
export function mergeMailReadStatus(
  statuses: readonly MailReadStatus[],
  threadCount: number,
): MailReadStatus {
  if (threadCount > 0) return 'ok';
  for (const status of UNAVAILABLE_PRIORITY) {
    if (statuses.includes(status)) return status;
  }
  return 'ok';
}

/** Port implementations may still return a bare message array (older fakes). */
export function unwrapThreadMessages<T>(raw: unknown): {
  messages: T[];
  status: MailReadStatus;
} {
  if (Array.isArray(raw)) {
    return { messages: raw as T[], status: 'ok' };
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { messages?: unknown }).messages)) {
    const result = raw as { messages: T[]; status?: unknown };
    return { messages: result.messages, status: parseMailReadStatus(result.status) };
  }
  return { messages: [], status: 'ok' };
}
