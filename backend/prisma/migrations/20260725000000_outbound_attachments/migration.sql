-- Short-lived staging for OUTBOUND attachment bytes on the external send lane.
-- Additive only: new table + its RLS. No existing object is altered.

-- CreateTable
CREATE TABLE "outbound_attachments" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "outbound_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_attachments_workspaceId_mailboxId_idx" ON "outbound_attachments"("workspaceId", "mailboxId");
CREATE INDEX "outbound_attachments_createdAt_idx" ON "outbound_attachments"("createdAt");

-- AddForeignKey
ALTER TABLE "outbound_attachments" ADD CONSTRAINT "outbound_attachments_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outbound_attachments" ADD CONSTRAINT "outbound_attachments_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grants for the runtime roles (guarded — roles exist on the deployed DBs).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "outbound_attachments" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "outbound_attachments" TO email_ops_ro;
  END IF;
END
$$;

-- RLS: workspace isolation, fail-closed with no GUC (same as scheduled_sends).
ALTER TABLE "outbound_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "outbound_attachments";
CREATE POLICY workspace_isolation ON "outbound_attachments"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
