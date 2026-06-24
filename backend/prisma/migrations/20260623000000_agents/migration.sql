-- ============================================================================
-- Email-Ops — Agent registry + autonomy dial (RLS-fenced)
-- ============================================================================
--
-- Adds the tenant-scoped, first-class identity for each agent that drafts/sends
-- mail (the registry behind the "Agents" view) plus the per-agent autonomy dial
-- (L0 draft-only / L1 approve-to-send / L2 autonomous-audit). `key` is the
-- stable provenance slug that supersedes the free-text agent_inbox_items.draftedBy
-- ('customer-ops', 'email-ops-agent', ...). `mailboxAccountId` is a SOFT reference
-- (no FK) to mailbox_accounts, matching the email_messages.mailboxAccountId
-- convention so the RLS-fenced mailbox table is resolved in app code, not
-- cross-referenced.
--
-- ROLLOUT POSTURE: identical to the other workspace-scoped tables — ENABLE +
-- FORCE RLS with the same `workspace_isolation` policy, plus least-privilege
-- grants for the runtime roles. Fail-closed when `current_workspace_id()` is NULL.

-- ----------------------------------------------------------------------------
-- 1. Enum (the autonomy dial)
-- ----------------------------------------------------------------------------

CREATE TYPE "AgentAutonomyLevel" AS ENUM ('L0_DRAFT_ONLY', 'L1_APPROVE_TO_SEND', 'L2_AUTONOMOUS_AUDIT');

-- ----------------------------------------------------------------------------
-- 2. Table + indexes + foreign key
-- ----------------------------------------------------------------------------

CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "mailboxAccountId" TEXT,
    "autonomyLevel" "AgentAutonomyLevel" NOT NULL DEFAULT 'L1_APPROVE_TO_SEND',
    "recipientPolicy" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agents_workspaceId_key_key"
  ON "agents"("workspaceId", "key");
CREATE INDEX "agents_workspaceId_idx"
  ON "agents"("workspaceId");
CREATE INDEX "agents_workspaceId_active_idx"
  ON "agents"("workspaceId", "active");

ALTER TABLE "agents"
  ADD CONSTRAINT "agents_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. Grants
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agents" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "agents" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 4. RLS — ENABLE + FORCE + workspace_isolation (same predicate as the rest)
-- ----------------------------------------------------------------------------

ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "agents";
CREATE POLICY workspace_isolation ON "agents"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
