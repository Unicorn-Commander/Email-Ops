-- ============================================================================
-- Cleanup archive metadata for archive-and-purge restore/vault retention
-- ============================================================================

ALTER TABLE "cleanup_batches"
  ADD COLUMN IF NOT EXISTS "archiveBucket" TEXT,
  ADD COLUMN IF NOT EXISTS "archiveKey" TEXT,
  ADD COLUMN IF NOT EXISTS "archiveBytes" BIGINT,
  ADD COLUMN IF NOT EXISTS "archiveSha256" TEXT,
  ADD COLUMN IF NOT EXISTS "archiveExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "archiveRetained" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "restoredAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "cleanup_batches_workspaceId_archiveExpiresAt_idx"
  ON "cleanup_batches"("workspaceId", "archiveExpiresAt")
  WHERE "archiveKey" IS NOT NULL AND "archiveRetained" = false;

GRANT SELECT, INSERT, UPDATE, DELETE ON "cleanup_batches" TO email_ops_app;
GRANT SELECT ON "cleanup_batches" TO email_ops_ro;

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
