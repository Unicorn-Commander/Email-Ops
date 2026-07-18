-- Capture the thread subject at snooze time so the Snoozed management view can
-- render a human-readable row — the snooze row otherwise only carries thread_id.
-- Nullable + display-only: an agent-initiated snooze that doesn't supply a
-- subject (and any row where the best-effort engine lookup degraded) stores NULL,
-- and the view falls back gracefully. No index — it is never filtered/sorted on.
ALTER TABLE "snoozed_threads" ADD COLUMN "subject" TEXT;
