-- ============================================================================
-- Email-Ops — scheduled-send claim timestamp (stuck-claim reaper)
-- ============================================================================
--
-- A CLAIMED row records WHEN it was claimed so the worker sweep can reclaim a
-- claim abandoned by a dead worker (claimedAt older than the TTL) and retry it.
-- composeEmail is idempotent on externalRef, so a reclaimed half-send is deduped
-- rather than doubled. Nullable + additive: existing PENDING rows are unaffected.

ALTER TABLE "scheduled_sends" ADD COLUMN "claimedAt" TIMESTAMP(3);

-- Index the reaper's scan path: due PENDING and stale CLAIMED both filter on
-- (state, <time>). The existing (state, sendAt) index already covers PENDING;
-- this covers the CLAIMED-by-claimedAt half of the OR.
CREATE INDEX "scheduled_sends_state_claimedAt_idx"
  ON "scheduled_sends"("state", "claimedAt");
