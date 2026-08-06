-- ============================================================================
-- Email-Ops — workspace-to-domain mail-engine binding
-- ============================================================================
--
-- A mail domain belongs to exactly one workspace. The global domain unique
-- constraint prevents two workspaces from claiming the same James control-plane
-- namespace; RLS prevents either workspace from reading the other's binding.

CREATE TABLE "mail_domains" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mail_domains_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_domains_domain_key" ON "mail_domains"("domain");
CREATE INDEX "mail_domains_workspaceId_idx" ON "mail_domains"("workspaceId");

ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grants are guarded so local/dev databases without the runtime roles migrate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_domains" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "mail_domains" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "mail_domains" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_domains" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "mail_domains";
CREATE POLICY workspace_isolation ON "mail_domains"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
