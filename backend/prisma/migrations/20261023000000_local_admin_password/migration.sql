-- Optional local password for the self-host bootstrap admin.
-- Existing SSO users remain passwordless (NULL); the app only creates or
-- updates this value when BOOTSTRAP_ADMIN_* is explicitly configured.
ALTER TABLE "users" ADD COLUMN "passwordHash" TEXT;
