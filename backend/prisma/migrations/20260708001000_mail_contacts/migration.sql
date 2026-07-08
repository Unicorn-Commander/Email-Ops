-- ============================================================================
-- Email-Ops — mailbox contacts for recipient autocomplete (RLS-fenced)
-- ============================================================================

CREATE TABLE "mail_contacts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxAccountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frequency" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_contacts_workspaceId_mailboxAccountId_email_key"
  ON "mail_contacts"("workspaceId", "mailboxAccountId", "email");
CREATE INDEX "mail_contacts_workspaceId_mailboxAccountId_frequency_lastSeenAt_idx"
  ON "mail_contacts"("workspaceId", "mailboxAccountId", "frequency", "lastSeenAt");

ALTER TABLE "mail_contacts"
  ADD CONSTRAINT "mail_contacts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mail_contacts"
  ADD CONSTRAINT "mail_contacts_mailboxAccountId_fkey"
  FOREIGN KEY ("mailboxAccountId") REFERENCES "mailbox_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_contacts" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "mail_contacts" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "mail_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "mail_contacts";
CREATE POLICY workspace_isolation ON "mail_contacts"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
