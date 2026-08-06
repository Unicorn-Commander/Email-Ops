-- ============================================================================
-- Email-Ops — Spaces (soft, overlapping groupings of mailboxes + agents)
-- ============================================================================
--
-- A Space is a soft "view" INSIDE the existing RLS workspace (NOT a new hard
-- tenant): it groups mailboxes + agents by context so the active Space can
-- filter /mail + the agents view. PERSONAL spaces are visible only to their
-- owner (`ownerKey` = the owner's keycloakId); TEAM spaces are shared across the
-- workspace (`ownerKey` null). A mailbox/agent can be in MANY spaces (the two
-- join tables). The implicit "All" view (no Space) shows everything.
--
-- ROLLOUT POSTURE: identical to the other workspace-scoped tables — ENABLE +
-- FORCE RLS, least-privilege grants for the runtime roles, fail-closed when
-- `current_workspace_id()` is NULL. `spaces` is fenced directly on its
-- workspaceId; the two pure join tables (no workspaceId column) are fenced via an
-- EXISTS-on-parent-space policy, so a join row is visible/writable only when its
-- Space is in the current workspace. The per-USER PERSONAL fence (the ownerKey
-- predicate) is enforced in app code on top of this per-WORKSPACE RLS fence.

-- ----------------------------------------------------------------------------
-- 1. Enum (the visibility flavor)
-- ----------------------------------------------------------------------------

CREATE TYPE "SpaceVisibility" AS ENUM ('PERSONAL', 'TEAM');

-- ----------------------------------------------------------------------------
-- 2. spaces — the grouping (workspace-scoped)
-- ----------------------------------------------------------------------------

CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerKey" TEXT,
    "visibility" "SpaceVisibility" NOT NULL DEFAULT 'PERSONAL',
    "name" TEXT NOT NULL,
    "color" TEXT,
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "spaces_workspaceId_ownerKey_idx"
  ON "spaces"("workspaceId", "ownerKey");
CREATE INDEX "spaces_workspaceId_visibility_idx"
  ON "spaces"("workspaceId", "visibility");

ALTER TABLE "spaces"
  ADD CONSTRAINT "spaces_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. space_mailboxes — Space ↔ MailboxAccount (many-to-many; cascade both ways)
-- ----------------------------------------------------------------------------

CREATE TABLE "space_mailboxes" (
    "spaceId" TEXT NOT NULL,
    "mailboxAccountId" TEXT NOT NULL,

    CONSTRAINT "space_mailboxes_pkey" PRIMARY KEY ("spaceId", "mailboxAccountId")
);

CREATE INDEX "space_mailboxes_mailboxAccountId_idx"
  ON "space_mailboxes"("mailboxAccountId");

ALTER TABLE "space_mailboxes"
  ADD CONSTRAINT "space_mailboxes_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "space_mailboxes"
  ADD CONSTRAINT "space_mailboxes_mailboxAccountId_fkey"
  FOREIGN KEY ("mailboxAccountId") REFERENCES "mailbox_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 4. space_agents — Space ↔ Agent (many-to-many; cascade both ways)
-- ----------------------------------------------------------------------------

CREATE TABLE "space_agents" (
    "spaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,

    CONSTRAINT "space_agents_pkey" PRIMARY KEY ("spaceId", "agentId")
);

CREATE INDEX "space_agents_agentId_idx"
  ON "space_agents"("agentId");

ALTER TABLE "space_agents"
  ADD CONSTRAINT "space_agents_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "space_agents"
  ADD CONSTRAINT "space_agents_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 5. Grants (least-privilege; only if the runtime roles exist)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "spaces" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "space_mailboxes" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "space_agents" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "spaces" TO email_ops_ro;
    GRANT SELECT ON "space_mailboxes" TO email_ops_ro;
    GRANT SELECT ON "space_agents" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 6. RLS — ENABLE + FORCE + workspace_isolation
-- ----------------------------------------------------------------------------

-- spaces: fenced directly on its own workspaceId (same predicate as the rest).
ALTER TABLE "spaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "spaces" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "spaces";
CREATE POLICY workspace_isolation ON "spaces"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

-- space_mailboxes: no workspaceId column → fence via the parent Space. A join row
-- is visible/writable only when its Space is in the current workspace (the nested
-- SELECT is itself RLS-fenced under the app role, so this is not circular).
ALTER TABLE "space_mailboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "space_mailboxes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "space_mailboxes";
CREATE POLICY workspace_isolation ON "space_mailboxes"
  USING (EXISTS (SELECT 1 FROM "spaces" s
                 WHERE s."id" = "spaceId" AND s."workspaceId" = current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "spaces" s
                      WHERE s."id" = "spaceId" AND s."workspaceId" = current_workspace_id()));

-- space_agents: same EXISTS-on-parent-space fence.
ALTER TABLE "space_agents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "space_agents" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "space_agents";
CREATE POLICY workspace_isolation ON "space_agents"
  USING (EXISTS (SELECT 1 FROM "spaces" s
                 WHERE s."id" = "spaceId" AND s."workspaceId" = current_workspace_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM "spaces" s
                      WHERE s."id" = "spaceId" AND s."workspaceId" = current_workspace_id()));
