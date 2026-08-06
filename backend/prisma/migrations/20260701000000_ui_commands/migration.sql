-- ============================================================================
-- Email-Ops — UI commands (the "agent controls the UI" surface / AG-UI seam)
-- ============================================================================
--
-- A UI command is enqueued by an agent (an MCP client authed AS the user) and
-- drained by that user's open cockpit on a focus-gated poll, which applies it
-- (navigate / open a thread / PREFILL a compose / switch Space / toast). None has
-- an external side effect. It is addressed to a (workspaceId, ucUid) pair.
--
-- ROLLOUT POSTURE: a workspace-scoped table, fenced like the rest — ENABLE +
-- FORCE RLS + the workspace_isolation policy on `workspaceId`. The per-USER fence
-- (the `ucUid` predicate) is enforced in app code on top of this per-WORKSPACE
-- RLS fence. Rows are ephemeral (drained on read via `consumedAt`).

-- ----------------------------------------------------------------------------
-- 1. Enum (the command kind)
-- ----------------------------------------------------------------------------

CREATE TYPE "UiCommandKind" AS ENUM ('NAVIGATE', 'OPEN_THREAD', 'COMPOSE', 'SWITCH_SPACE', 'NOTIFY');

-- ----------------------------------------------------------------------------
-- 2. ui_commands — the per-(workspace,user) command outbox
-- ----------------------------------------------------------------------------

CREATE TABLE "ui_commands" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ucUid" TEXT NOT NULL,
    "kind" "UiCommandKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "ui_commands_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ui_commands_workspaceId_ucUid_consumedAt_idx"
  ON "ui_commands"("workspaceId", "ucUid", "consumedAt");

ALTER TABLE "ui_commands"
  ADD CONSTRAINT "ui_commands_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. Grants (least-privilege; only if the runtime roles exist)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ui_commands" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "ui_commands" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 4. RLS — ENABLE + FORCE + workspace_isolation (fenced on its own workspaceId)
-- ----------------------------------------------------------------------------

ALTER TABLE "ui_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ui_commands" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "ui_commands";
CREATE POLICY workspace_isolation ON "ui_commands"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
