-- ============================================================================
-- Email-Ops — mailbox signatures (RLS-fenced)
-- ============================================================================
--
-- Per-mailbox reusable HTML signatures for the human mail client. Tenant scoped
-- exactly like mailbox_accounts: every row carries workspaceId, all app access
-- goes through withWorkspace(), and Postgres enforces fail-closed RLS.

CREATE TABLE "mail_signatures" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_signatures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mail_signatures_workspaceId_mailboxAccountId_idx"
  ON "mail_signatures"("workspaceId", "mailboxAccountId");
CREATE INDEX "mail_signatures_workspaceId_mailboxAccountId_isDefault_idx"
  ON "mail_signatures"("workspaceId", "mailboxAccountId", "isDefault");

ALTER TABLE "mail_signatures"
  ADD CONSTRAINT "mail_signatures_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mail_signatures"
  ADD CONSTRAINT "mail_signatures_mailboxAccountId_fkey"
  FOREIGN KEY ("mailboxAccountId") REFERENCES "mailbox_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_signatures" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "mail_signatures" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "mail_signatures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_signatures" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "mail_signatures";
CREATE POLICY workspace_isolation ON "mail_signatures"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
