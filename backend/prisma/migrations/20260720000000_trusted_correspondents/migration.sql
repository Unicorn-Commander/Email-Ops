-- ============================================================================
-- Email-Ops Wave 7 — trusted correspondents (the agent-send learning table)
-- ============================================================================
--
-- Workspace-scoped, RLS-fenced allowlist of OUTBOUND addresses a human has
-- vouched for: approving a staged agent draft learns its external recipients
-- (source APPROVAL, approvalCount++), or an operator adds one explicitly
-- (source MANUAL). The autonomy gate consults this table for the L2 external
-- ROUTINE check ("first contact needs a human; ongoing conversation flows").
-- Deliberately separate from sender_policies (the INBOUND allow/block surface).

CREATE TYPE "TrustedCorrespondentSource" AS ENUM ('MANUAL', 'APPROVAL');

CREATE TABLE "trusted_correspondents" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "source" "TrustedCorrespondentSource" NOT NULL DEFAULT 'APPROVAL',
    "approvalCount" INTEGER NOT NULL DEFAULT 0,
    "lastApprovedAt" TIMESTAMP(3),
    "addedByUcUid" TEXT,
    "addedByAgentKey" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trusted_correspondents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trusted_correspondents_workspaceId_address_key"
  ON "trusted_correspondents"("workspaceId", "address");
CREATE INDEX "trusted_correspondents_workspaceId_idx"
  ON "trusted_correspondents"("workspaceId");

ALTER TABLE "trusted_correspondents" ADD CONSTRAINT "trusted_correspondents_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grants are guarded so local/dev databases without the runtime roles migrate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "trusted_correspondents" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "trusted_correspondents" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "trusted_correspondents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "trusted_correspondents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "trusted_correspondents";
CREATE POLICY workspace_isolation ON "trusted_correspondents"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
