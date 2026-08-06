-- ============================================================================
-- Email-Ops — Agent controls (kill switch) + the agent-mail action/audit log
-- ============================================================================
--
-- Adds (1) the workspace kill switch `workspaces.agentsPaused` (control table —
-- not RLS-fenced; the existing grants cover it), and (2) the tenant-scoped
-- `agent_action_events` audit log behind the activity feed + the
-- "autonomous-with-audit" guarantee. The audit table is RLS-fenced exactly like
-- the other scoped tables (ENABLE + FORCE + the workspace_isolation policy + the
-- least-privilege runtime grants); fail-closed when current_workspace_id() is NULL.

-- ----------------------------------------------------------------------------
-- 1. Kill switch (workspaces is the control table — plain column add)
-- ----------------------------------------------------------------------------

ALTER TABLE "workspaces"
  ADD COLUMN "agentsPaused" BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------------------------
-- 2. Audit-log enum + table + indexes + foreign key
-- ----------------------------------------------------------------------------

CREATE TYPE "AgentActionKind" AS ENUM (
  'AUTONOMOUS_SEND',
  'STAGED_FOR_APPROVAL',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'RESUMED'
);

CREATE TABLE "agent_action_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "AgentActionKind" NOT NULL,
    "agentKey" TEXT,
    "messageId" TEXT,
    "actorUcUid" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_action_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_action_events_workspaceId_idx"
  ON "agent_action_events"("workspaceId");
CREATE INDEX "agent_action_events_workspaceId_createdAt_idx"
  ON "agent_action_events"("workspaceId", "createdAt");

ALTER TABLE "agent_action_events"
  ADD CONSTRAINT "agent_action_events_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. Grants
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_action_events" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "agent_action_events" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 4. RLS — ENABLE + FORCE + workspace_isolation (same predicate as the rest)
-- ----------------------------------------------------------------------------

ALTER TABLE "agent_action_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_action_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "agent_action_events";
CREATE POLICY workspace_isolation ON "agent_action_events"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
