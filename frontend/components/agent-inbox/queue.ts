import type { AgentInboxItemView, BulkApproveAgentInboxResult } from '../../lib/api';

export type QueueSort = 'created' | 'kit' | 'sender' | 'recipient' | 'tier';
export type QueueStateFilter = 'all' | 'pending' | 'approved' | 'rejected';
export type QueueKitFilter = 'all' | 'with-kit' | 'without-kit' | string;

function createdAt(item: AgentInboxItemView): number {
  const timestamp = Date.parse(item.created_at ?? '');
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function recipientLine(item: Pick<AgentInboxItemView, 'to_address' | 'to_addresses' | 'cc' | 'bcc'>): string {
  const tos = item.to_addresses?.length ? item.to_addresses : item.to_address ? [item.to_address] : [];
  const bits: string[] = [];
  if (tos.length) bits.push(tos.join(', '));
  if (item.cc?.length) bits.push(`cc ${item.cc.join(', ')}`);
  if (item.bcc?.length) bits.push(`bcc ${item.bcc.join(', ')}`);
  return bits.join('; ');
}

/** Apply the queue's visible filters and stable operator-facing sort order. */
export function filterAndSortQueue(
  items: AgentInboxItemView[],
  stateFilter: QueueStateFilter,
  kitFilter: QueueKitFilter,
  sort: QueueSort,
): AgentInboxItemView[] {
  const filtered = items.filter((item) => {
    if (stateFilter !== 'all' && item.state !== stateFilter) return false;
    if (kitFilter === 'with-kit' && !item.kit_id) return false;
    if (kitFilter === 'without-kit' && item.kit_id) return false;
    if (
      kitFilter !== 'all' &&
      kitFilter !== 'with-kit' &&
      kitFilter !== 'without-kit' &&
      item.kit_id !== kitFilter
    ) {
      return false;
    }
    return true;
  });

  return [...filtered].sort((a, b) => {
    if (sort === 'created') return createdAt(b) - createdAt(a);
    if (sort === 'kit') return (a.kit_id ?? '').localeCompare(b.kit_id ?? '') || createdAt(b) - createdAt(a);
    if (sort === 'sender') return (a.from_address ?? '').localeCompare(b.from_address ?? '') || createdAt(b) - createdAt(a);
    if (sort === 'recipient') return recipientLine(a).localeCompare(recipientLine(b)) || createdAt(b) - createdAt(a);
    return a.approval_tier.localeCompare(b.approval_tier) || createdAt(b) - createdAt(a);
  });
}

export function pendingQueueIds(items: AgentInboxItemView[]): string[] {
  return items.filter((item) => item.state === 'pending').map((item) => item.id);
}

export function toggleVisibleSelection(
  selected: ReadonlySet<string>,
  visiblePendingIds: string[],
): Set<string> {
  const next = new Set(selected);
  const allSelected = visiblePendingIds.length > 0 && visiblePendingIds.every((id) => next.has(id));
  visiblePendingIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
  return next;
}

function formatScheduleTime(iso: string | null): string {
  if (!iso) return 'now';
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Render the short confirmation line shown after a paced bulk approval. */
export function formatBulkSchedule(result: BulkApproveAgentInboxResult): string {
  const schedule = result.schedule;
  if (schedule.count === 0) {
    return `${result.approved_count} approved${result.refused_count ? `; ${result.refused_count} refused` : ''}.`;
  }
  const counts = Object.values(schedule.count_per_sender);
  const perSender =
    counts.length > 0 && counts.every((count) => count === counts[0])
      ? `${counts[0]} per sender`
      : `${counts.join(' + ')} across senders`;
  return `${result.approved_count} approved; sends from ${formatScheduleTime(schedule.first_send)} to ${formatScheduleTime(schedule.last_send)}, ${perSender}${result.refused_count ? `; ${result.refused_count} refused` : ''}.`;
}
