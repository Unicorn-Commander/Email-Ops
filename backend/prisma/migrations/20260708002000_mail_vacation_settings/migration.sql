-- ============================================================================
-- Email-Ops — mailbox vacation/autoresponder settings (RLS-fenced)
-- ============================================================================
--
-- Per-mailbox vacation / out-of-office settings. Tenant scoped exactly like
-- mailbox_accounts: every row carries workspaceId, all app access goes through
-- withWorkspace(), and Postgres enforces fail-closed RLS.

CREATE TABLE "mail_vacation_settings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxAccountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "subject" TEXT NOT NULL DEFAULT '',
    "bodyHtml" TEXT NOT NULL DEFAULT '',
    "bodyText" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_vacation_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_vacation_settings_workspaceId_mailboxAccountId_key"
  ON "mail_vacation_settings"("workspaceId", "mailboxAccountId");
CREATE INDEX "mail_vacation_settings_workspaceId_mailboxAccountId_idx"
  ON "mail_vacation_settings"("workspaceId", "mailboxAccountId");

ALTER TABLE "mail_vacation_settings"
  ADD CONSTRAINT "mail_vacation_settings_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mail_vacation_settings"
  ADD CONSTRAINT "mail_vacation_settings_mailboxAccountId_fkey"
  FOREIGN KEY ("mailboxAccountId") REFERENCES "mailbox_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_vacation_settings" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "mail_vacation_settings" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "mail_vacation_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_vacation_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "mail_vacation_settings";
CREATE POLICY workspace_isolation ON "mail_vacation_settings"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
