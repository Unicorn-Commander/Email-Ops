-- Email-Ops calendar device metadata. Davis remains the credential authority;
-- this table deliberately has no plaintext secret and no secret hash.

CREATE TABLE "calendar_device_keys" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "davisAppId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "calendar_device_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "calendar_device_keys_workspaceId_davisAppId_key"
  ON "calendar_device_keys"("workspaceId", "davisAppId");
CREATE INDEX "calendar_device_keys_workspaceId_idx"
  ON "calendar_device_keys"("workspaceId");
CREATE INDEX "calendar_device_keys_workspaceId_mailboxId_revokedAt_idx"
  ON "calendar_device_keys"("workspaceId", "mailboxId", "revokedAt");
CREATE INDEX "calendar_device_keys_workspaceId_expiresAt_idx"
  ON "calendar_device_keys"("workspaceId", "expiresAt");

ALTER TABLE "calendar_device_keys"
  ADD CONSTRAINT "calendar_device_keys_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "calendar_device_keys"
  ADD CONSTRAINT "calendar_device_keys_mailboxId_fkey"
  FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "calendar_device_keys" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "calendar_device_keys" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "calendar_device_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_device_keys" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "calendar_device_keys";
CREATE POLICY workspace_isolation ON "calendar_device_keys"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
