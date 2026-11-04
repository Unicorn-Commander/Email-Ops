export const DEFAULT_KIT_APPROVAL_SECONDS_BETWEEN = 61;
export const DEFAULT_DIRECT_APPROVAL_SECONDS_BETWEEN = 2;

export interface AgentInboxScheduleCandidate {
  itemId: string;
  sender: string;
  kitId?: string | null;
  approvalSecondsBetween?: number | null;
  notBefore?: Date | null;
  expiresAt?: Date | null;
  capPerDay?: number | null;
  sentToday?: number;
}

export interface AgentInboxScheduledItem {
  itemId: string;
  sender: string;
  kitId: string | null;
  sendAt: Date;
  approvalSecondsBetween: number;
}

export interface AgentInboxScheduleRefusal {
  itemId: string;
  reason: string;
}

export interface AgentInboxSchedulePlan {
  scheduled: AgentInboxScheduledItem[];
  refused: AgentInboxScheduleRefusal[];
  firstSend: Date | null;
  lastSend: Date | null;
  countPerSender: Record<string, number>;
}

function validPositiveSeconds(value: number | null | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.ceil(value as number) : fallback;
}

function maxDate(...dates: Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

/**
 * Build a stable, per-sender send schedule for a bulk approval.
 *
 * The planner is deliberately pure: the service supplies the current kit cap
 * counters and persists the returned timestamps in the existing draft
 * `sendAt`/`payload.sends_at` path. A kit's optional pacing override is accepted
 * for forward-compatible fixtures; the production default is 61 seconds.
 */
export function planAgentInboxSchedule(
  candidates: AgentInboxScheduleCandidate[],
  now = new Date(),
): AgentInboxSchedulePlan {
  const senderNextAt = new Map<string, Date>();
  const kitCounts = new Map<string, number>();
  const scheduled: AgentInboxScheduledItem[] = [];
  const refused: AgentInboxScheduleRefusal[] = [];
  const countPerSender: Record<string, number> = {};
  let firstSend: Date | null = null;
  let lastSend: Date | null = null;

  for (const candidate of candidates) {
    const hasKit = Boolean(candidate.kitId);
    const step = validPositiveSeconds(
      candidate.approvalSecondsBetween,
      hasKit ? DEFAULT_KIT_APPROVAL_SECONDS_BETWEEN : DEFAULT_DIRECT_APPROVAL_SECONDS_BETWEEN,
    );

    if (hasKit) {
      if (
        !candidate.expiresAt ||
        !Number.isFinite(candidate.expiresAt.getTime()) ||
        candidate.expiresAt <= now
      ) {
        refused.push({ itemId: candidate.itemId, reason: 'kit_expired' });
        continue;
      }
      const cap = candidate.capPerDay;
      const sentToday = candidate.sentToday ?? 0;
      const reserved = kitCounts.get(candidate.kitId as string) ?? 0;
      if (Number.isFinite(cap) && (cap as number) >= 0 && sentToday + reserved >= (cap as number)) {
        refused.push({ itemId: candidate.itemId, reason: 'cap_reached' });
        continue;
      }
    }

    if (candidate.notBefore && !Number.isFinite(candidate.notBefore.getTime())) {
      refused.push({ itemId: candidate.itemId, reason: 'invalid_not_before' });
      continue;
    }

    const earliest = maxDate(
      now,
      candidate.notBefore ?? now,
      senderNextAt.get(candidate.sender) ?? now,
    );
    if (hasKit && candidate.expiresAt && earliest >= candidate.expiresAt) {
      refused.push({ itemId: candidate.itemId, reason: 'kit_expired' });
      continue;
    }

    const sendAt = earliest;
    scheduled.push({
      itemId: candidate.itemId,
      sender: candidate.sender,
      kitId: candidate.kitId ?? null,
      sendAt,
      approvalSecondsBetween: step,
    });
    senderNextAt.set(candidate.sender, new Date(sendAt.getTime() + step * 1000));
    countPerSender[candidate.sender] = (countPerSender[candidate.sender] ?? 0) + 1;
    if (hasKit)
      kitCounts.set(candidate.kitId as string, (kitCounts.get(candidate.kitId as string) ?? 0) + 1);
    if (!firstSend || sendAt < firstSend) firstSend = sendAt;
    if (!lastSend || sendAt > lastSend) lastSend = sendAt;
  }

  return { scheduled, refused, firstSend, lastSend, countPerSender };
}
