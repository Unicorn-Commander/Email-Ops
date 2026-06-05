-- ============================================================================
-- Cleanup batch audit log + agent-inbox cleanup payloads
-- ============================================================================

DO $$
BEGIN
  CREATE TYPE "AgentInboxKind" AS ENUM ('EMAIL', 'CLEANUP');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "CleanupActionKind" AS ENUM ('TRASH', 'DELETE', 'ORGANIZE', 'UNSUBSCRIBE', 'UNDO');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE "CleanupBatchState" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED', 'FAILED', 'UNDONE', 'CANCELED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE "agent_inbox_items"
  ADD COLUMN IF NOT EXISTS "kind" "AgentInboxKind" NOT NULL DEFAULT 'EMAIL',
  ADD COLUMN IF NOT EXISTS "payload" JSONB;

ALTER TABLE "agent_inbox_items"
  ALTER COLUMN "messageId" DROP NOT NULL;

CREATE TABLE IF NOT EXISTS "cleanup_batches" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "action" "CleanupActionKind" NOT NULL,
  "mode" TEXT NOT NULL,
  "state" "CleanupBatchState" NOT NULL DEFAULT 'PENDING',
  "criteria" JSONB,
  "plan" JSONB NOT NULL,
  "result" JSONB,
  "backupRef" TEXT,
  "backupVerified" BOOLEAN NOT NULL DEFAULT false,
  "requestedByUcUid" TEXT,
  "approvedByUcUid" TEXT,
  "agentInboxItemId" TEXT,
  "summary" TEXT,
  "params" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "undoneAt" TIMESTAMP(3),

  CONSTRAINT "cleanup_batches_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "cleanup_batches"
  ADD CONSTRAINT "cleanup_batches_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cleanup_batches"
  ADD CONSTRAINT "cleanup_batches_agentInboxItemId_fkey"
  FOREIGN KEY ("agentInboxItemId") REFERENCES "agent_inbox_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "cleanup_batches_workspaceId_idx" ON "cleanup_batches"("workspaceId");
CREATE INDEX IF NOT EXISTS "cleanup_batches_workspaceId_state_createdAt_idx" ON "cleanup_batches"("workspaceId", "state", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "cleanup_batches_agentInboxItemId_key" ON "cleanup_batches"("agentInboxItemId");

GRANT USAGE ON TYPE "AgentInboxKind", "CleanupActionKind", "CleanupBatchState"
  TO email_ops_app, email_ops_audit, email_ops_ro, email_ops_owner;

GRANT SELECT, INSERT, UPDATE, DELETE ON "cleanup_batches" TO email_ops_app;
GRANT SELECT ON "cleanup_batches" TO email_ops_ro;

ALTER DEFAULT PRIVILEGES FOR ROLE email_ops_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO email_ops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE email_ops_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO email_ops_ro;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE cleanup_batches ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE cleanup_batches FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS workspace_isolation ON cleanup_batches';
  EXECUTE 'CREATE POLICY workspace_isolation ON cleanup_batches '
       || 'USING ("workspaceId" = current_workspace_id()) '
       || 'WITH CHECK ("workspaceId" = current_workspace_id())';
END
$$;
