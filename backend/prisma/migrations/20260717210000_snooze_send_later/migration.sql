-- ============================================================================
-- Email-Ops — snooze + send-later scheduler state
-- ============================================================================
--
-- Both tables are workspace-scoped, RLS-fenced scheduler state. User-facing
-- access is always through withWorkspace(); the worker scans due rows through
-- systemClient and then performs per-row effects idempotently.

CREATE TYPE "SnoozedThreadState" AS ENUM ('ACTIVE', 'SURFACED', 'CANCELLED');
CREATE TYPE "ScheduledSendState" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'CANCELLED', 'FAILED');

CREATE TABLE "snoozed_threads" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "snoozeUntil" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "state" "SnoozedThreadState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "snoozed_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "scheduled_sends" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "state" "ScheduledSendState" NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    CONSTRAINT "scheduled_sends_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "snoozed_threads_workspaceId_mailboxId_state_snoozeUntil_idx"
  ON "snoozed_threads"("workspaceId", "mailboxId", "state", "snoozeUntil");
CREATE INDEX "snoozed_threads_state_snoozeUntil_idx"
  ON "snoozed_threads"("state", "snoozeUntil");

CREATE INDEX "scheduled_sends_workspaceId_mailboxId_state_sendAt_idx"
  ON "scheduled_sends"("workspaceId", "mailboxId", "state", "sendAt");
CREATE INDEX "scheduled_sends_state_sendAt_idx"
  ON "scheduled_sends"("state", "sendAt");

ALTER TABLE "snoozed_threads" ADD CONSTRAINT "snoozed_threads_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "snoozed_threads" ADD CONSTRAINT "snoozed_threads_mailboxId_fkey"
  FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scheduled_sends" ADD CONSTRAINT "scheduled_sends_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "scheduled_sends" ADD CONSTRAINT "scheduled_sends_mailboxId_fkey"
  FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grants are guarded so local/dev databases without the runtime roles migrate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "snoozed_threads" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "scheduled_sends" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "snoozed_threads" TO email_ops_ro;
    GRANT SELECT ON "scheduled_sends" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "snoozed_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "snoozed_threads" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "snoozed_threads";
CREATE POLICY workspace_isolation ON "snoozed_threads"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

ALTER TABLE "scheduled_sends" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_sends" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "scheduled_sends";
CREATE POLICY workspace_isolation ON "scheduled_sends"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
