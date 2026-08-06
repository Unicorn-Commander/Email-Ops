/**
 * Normalized "what would this cleanup touch" preview.
 *
 * A CLEANUP agent-inbox item stages a batch that MOVES / TRASHES / DELETES mail;
 * the human who approves it must be able to see WHAT is proposed — not just a
 * one-line "trash 42 messages" summary. This module builds a compact, BOUNDED
 * target preview (a total, a verb, and up to MAX_TARGET_ROWS readable rows) that
 * both the agent-inbox ReviewCard and the in-chat confirm card render, and that
 * MCP/agent callers see on the item payload.
 *
 * Bounded on purpose: we never persist thousands of rows on the item — the top
 * senders (or the first few subjects) plus a `truncated` flag are enough for a
 * human to trust the batch. Degrade-clean: an absent/garbage plan yields a
 * zero-row preview rather than throwing.
 */

/** Cap on the rows persisted / rendered for a cleanup preview. */
export const MAX_TARGET_ROWS = 8;

/** One readable line in a cleanup preview: a sender group (messages) or a thread (subject). */
export interface CleanupTargetRow {
  subject?: string | null;
  sender?: string | null;
  /** How many messages this sender group covers (message-scope previews). */
  count?: number;
}

/** A bounded, human-readable preview of a staged cleanup batch's targets. */
export interface CleanupTargets {
  /** What happens on approval, already human-cased: "Archive" / "Move to Trash" / "Permanently delete". */
  verb: string;
  /** Whether `total`/rows count messages (external cleaner) or threads (native inbox). */
  scope: 'messages' | 'threads';
  /** Where the batch runs: "gmail" | "microsoft" | "this inbox". */
  provider?: string | null;
  /** Total messages/threads the batch would affect. */
  total: number;
  /** Up to MAX_TARGET_ROWS readable rows (top senders, or the first subjects). */
  rows: CleanupTargetRow[];
  /** Messages the plan deliberately SKIPPED as protected (starred / bank / .gov …). */
  protected_count?: number;
  /** Storage the batch would free, in bytes (message-scope only; 0 when unknown). */
  frees_bytes?: number;
  /** True when there are more distinct senders/threads than the rows shown. */
  truncated?: boolean;
}

/** Human-case the destructive verb from an action/mode token. */
export function cleanupVerb(action: string | null | undefined): string {
  const a = String(action ?? '').trim().toUpperCase();
  if (a === 'DELETE' || a === 'ARCHIVE_PURGE') return 'Permanently delete';
  if (a === 'ARCHIVE' || a === 'ORGANIZE' || a === 'LABEL') return 'Archive';
  return 'Move to Trash';
}

/** "Jane Doe <jane@acme.com>" → "Jane Doe"; a bare address stays as-is. */
export function displaySender(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '(unknown sender)';
  const named = s.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (named && named[1].trim()) return named[1].trim();
  return s;
}

type PlanLike =
  | {
      counts?: { safe?: number; protected?: number } | null;
      safe?: Array<{ sender?: string | null }> | null;
      freesBytes?: number | null;
    }
  | null
  | undefined;

/**
 * Build a bounded, message-scoped preview from a Cleaner-Engine plan: group the
 * safe set by sender, keep the top MAX_TARGET_ROWS by count. Shared by the stage
 * path (persisted on the item) and the assistant confirm card so both agree.
 */
export function cleanupTargetsFromPlan(
  action: string | null | undefined,
  provider: string | null,
  plan: PlanLike,
): CleanupTargets {
  const safe = Array.isArray(plan?.safe) ? plan!.safe! : [];
  const total = plan?.counts?.safe ?? safe.length;
  const bySender = new Map<string, number>();
  for (const row of safe) {
    const key = displaySender(row?.sender ?? null);
    bySender.set(key, (bySender.get(key) ?? 0) + 1);
  }
  const rows: CleanupTargetRow[] = [...bySender.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TARGET_ROWS)
    .map(([sender, count]) => ({ sender, count }));
  return {
    verb: cleanupVerb(action),
    scope: 'messages',
    provider: provider ?? null,
    total,
    rows,
    protected_count: plan?.counts?.protected ?? 0,
    frees_bytes: plan?.freesBytes ?? 0,
    truncated: bySender.size > rows.length,
  };
}
