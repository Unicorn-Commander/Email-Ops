-- ============================================================================
-- Email-Ops Phase 3b — ConnectedAccounts (RLS-fenced, encrypted OAuth vault)
-- ============================================================================
--
-- Adds the tenant-scoped system-of-record binding to a customer's external
-- email account (Gmail / Microsoft 365). The Cleaner Engine stays stateless:
-- this backend owns the workspace tenancy, the encrypted credential vault, and
-- the row-level fence.
--
-- ROLLOUT POSTURE: identical to the other workspace-scoped tables — ENABLE +
-- FORCE RLS with the same `workspace_isolation` policy, plus least-privilege
-- grants for the runtime roles. The table is fail-closed when
-- `current_workspace_id()` is NULL.

-- ----------------------------------------------------------------------------
-- 1. Table + indexes + foreign key
-- ----------------------------------------------------------------------------

CREATE TABLE "connected_accounts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "encryptedCredentials" TEXT NOT NULL,
    "credentialsExpireAt" TIMESTAMP(3),
    "lastAnalyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connected_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "connected_accounts_workspaceId_provider_emailAddress_key"
  ON "connected_accounts"("workspaceId", "provider", "emailAddress");
CREATE INDEX "connected_accounts_workspaceId_idx"
  ON "connected_accounts"("workspaceId");

ALTER TABLE "connected_accounts"
  ADD CONSTRAINT "connected_accounts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 2. Grants
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "connected_accounts" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "connected_accounts" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 3. RLS — ENABLE + FORCE + workspace_isolation (same predicate as the rest)
-- ----------------------------------------------------------------------------

ALTER TABLE "connected_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connected_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "connected_accounts";
CREATE POLICY workspace_isolation ON "connected_accounts"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
