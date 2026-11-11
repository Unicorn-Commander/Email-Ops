-- CreateTable
CREATE TABLE "external_imap_accounts" (
    "mailboxId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 993,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,

    CONSTRAINT "external_imap_accounts_pkey" PRIMARY KEY ("mailboxId")
);

-- AddForeignKey
ALTER TABLE "external_imap_accounts" ADD CONSTRAINT "external_imap_accounts_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Match the runtime grants on connected_accounts and mailbox_accounts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "external_imap_accounts" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "external_imap_accounts" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "external_imap_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_imap_accounts" FORCE ROW LEVEL SECURITY;

-- Inherit the parent mailbox's RLS visibility, including any owner policies.
-- mailbox_accounts currently fences workspaces in SQL; ownership is checked
-- in the application. Missing workspace context fails closed for both tables.
CREATE POLICY workspace_isolation ON "external_imap_accounts"
  USING (EXISTS (
    SELECT 1 FROM "mailbox_accounts" AS mailbox
    WHERE mailbox.id = "external_imap_accounts"."mailboxId"
      AND mailbox."workspaceId" = current_workspace_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "mailbox_accounts" AS mailbox
    WHERE mailbox.id = "external_imap_accounts"."mailboxId"
      AND mailbox."workspaceId" = current_workspace_id()
  ));
