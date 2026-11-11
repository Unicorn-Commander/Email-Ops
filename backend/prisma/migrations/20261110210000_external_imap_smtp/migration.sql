-- AlterTable
ALTER TABLE "external_imap_accounts" ADD COLUMN     "smtpEncryptedPassword" TEXT,
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpUsername" TEXT;

-- SMTP credentials share the existing external_imap_accounts row, grants,
-- forced RLS and workspace_isolation USING/WITH CHECK policy. No new table or
-- broader policy is introduced; parent mailbox visibility remains authoritative.
ALTER TABLE "external_imap_accounts" ADD CONSTRAINT "external_imap_smtp_settings_check"
CHECK (("smtpHost" IS NULL AND "smtpPort" IS NULL AND "smtpUsername" IS NULL AND "smtpEncryptedPassword" IS NULL)
    OR ("smtpHost" IS NOT NULL AND "smtpPort" IS NOT NULL AND "smtpPort" IN (465, 587)));
