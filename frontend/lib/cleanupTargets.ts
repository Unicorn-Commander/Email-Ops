/**
 * Client-side reader for a CLEANUP item's "what would this touch" preview.
 *
 * A cleanup agent-inbox item stages a batch that MOVES / TRASHES / DELETES mail.
 * The human approving it must see the concrete targets — not just a one-line
 * "trash 42 messages" summary. The backend now persists a bounded `targets`
 * preview on the item payload (and on the in-chat action); this module reads it,
 * and — for items staged before that change — DERIVES an equivalent preview from
 * the raw `plan` / `thread_ids` already on the payload. Degrade-clean: anything
 * it can't understand yields `null`, and the card falls back to the summary.
 *
 * Mirrors backend/src/connected-accounts/cleanup-targets.ts.
 */

const MAX_TARGET_ROWS = 8;

export interface CleanupTargetRow {
  subject?: string | null;
  sender?: string | null;
  count?: number;
}

export interface CleanupTargets {
  verb: string;
  scope: 'messages' | 'threads';
  provider?: string | null;
  total: number;
  rows: CleanupTargetRow[];
  protected_count?: number;
  frees_bytes?: number;
  truncated?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanStr(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t || null;
}

/** Human-case the destructive verb from an action/mode/disposition token. */
export function cleanupVerb(action: unknown): string {
  const a = String(action ?? '').trim().toUpperCase();
  if (a === 'DELETE' || a === 'ARCHIVE_PURGE') return 'Permanently delete';
  if (a === 'ARCHIVE' || a === 'ORGANIZE' || a === 'LABEL') return 'Archive';
  return 'Move to Trash';
}

/** The agent's stated rationale for a staged cleanup, when it recorded one. */
export function cleanupReason(payload: unknown): string | null {
  const p = asRecord(payload);
  return p ? cleanStr(p.reason) : null;
}

/** "Jane Doe <jane@acme.com>" → "Jane Doe"; a bare address stays as-is. */
export function displaySender(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '(unknown sender)';
  const named = s.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (named && named[1].trim()) return named[1].trim();
  return s;
}

/** Validate + normalize a raw `targets` object (from item payload or a chat action). */
export function coerceCleanupTargets(raw: unknown): CleanupTargets | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const total = Number(rec.total);
  if (!Number.isFinite(total)) return null;
  const scope = rec.scope === 'threads' ? 'threads' : 'messages';
  const rowsRaw = Array.isArray(rec.rows) ? rec.rows : [];
  const rows: CleanupTargetRow[] = rowsRaw
    .map((r) => asRecord(r))
    .filter((r): r is Record<string, unknown> => r !== null)
    .slice(0, MAX_TARGET_ROWS)
    .map((r) => ({
      subject: cleanStr(r.subject),
      sender: cleanStr(r.sender),
      count: Number.isFinite(Number(r.count)) ? Number(r.count) : undefined,
    }));
  return {
    verb: cleanStr(rec.verb) ?? 'Clean up',
    scope,
    provider: cleanStr(rec.provider),
    total: Math.max(0, Math.trunc(total)),
    rows,
    protected_count: Number.isFinite(Number(rec.protected_count))
      ? Number(rec.protected_count)
      : undefined,
    frees_bytes: Number.isFinite(Number(rec.frees_bytes)) ? Number(rec.frees_bytes) : undefined,
    truncated: Boolean(rec.truncated),
  };
}

/** Group a Cleaner-Engine plan's safe set by sender → bounded message-scope rows. */
function fromPlan(payload: Record<string, unknown>): CleanupTargets | null {
  const plan = asRecord(payload.plan);
  if (!plan) return null;
  const safe = Array.isArray(plan.safe) ? plan.safe : [];
  const counts = asRecord(plan.counts);
  const total = Number(counts?.safe ?? safe.length);
  const bySender = new Map<string, number>();
  for (const row of safe) {
    const rec = asRecord(row);
    const key = displaySender(rec?.sender ?? null);
    bySender.set(key, (bySender.get(key) ?? 0) + 1);
  }
  const rows: CleanupTargetRow[] = [...bySender.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TARGET_ROWS)
    .map(([sender, count]) => ({ sender, count }));
  return {
    verb: cleanupVerb(payload.action),
    scope: 'messages',
    provider: cleanStr(payload.provider),
    total: Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : safe.length,
    rows,
    protected_count: Number.isFinite(Number(counts?.protected)) ? Number(counts?.protected) : undefined,
    frees_bytes: Number.isFinite(Number(plan.freesBytes)) ? Number(plan.freesBytes) : undefined,
    truncated: bySender.size > rows.length,
  };
}

/**
 * The best preview available for an agent-inbox item payload:
 *   1. the persisted `targets` (new items, both native + external), else
 *   2. a preview DERIVED from the Cleaner-Engine `plan` (older external items), else
 *   3. a count-only preview from native `thread_ids` (older native items), else null.
 */
export function deriveCleanupTargets(
  payload: Record<string, unknown> | null | undefined,
): CleanupTargets | null {
  const rec = asRecord(payload);
  if (!rec) return null;

  const persisted = coerceCleanupTargets(rec.targets);
  if (persisted) return persisted;

  const derived = fromPlan(rec);
  if (derived) return derived;

  if (Array.isArray(rec.thread_ids)) {
    const total = rec.thread_ids.length;
    if (total === 0) return null;
    return {
      verb: cleanupVerb(rec.action),
      scope: 'threads',
      provider: rec.native ? 'this inbox' : cleanStr(rec.provider),
      total,
      rows: [],
      truncated: false,
    };
  }
  return null;
}

/** Compact human byte size for a cleanup preview line. */
export function formatBytes(bytes: number | undefined | null): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Messages/threads NOT shown as explicit rows (for an honest "+ N more" line). */
export function remainingCount(targets: CleanupTargets): number {
  if (targets.scope === 'messages') {
    const shown = targets.rows.reduce((sum, r) => sum + (r.count ?? 0), 0);
    return Math.max(0, targets.total - shown);
  }
  return Math.max(0, targets.total - targets.rows.length);
}
