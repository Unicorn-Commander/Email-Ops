-- ============================================================================
-- Email-Ops — Agent Command Center: mailbox ownership + multi-mailbox + provisioning
-- ============================================================================
--
-- Additive, RLS-inherited, inert until read. Adds: mailbox ownership/provision
-- state, the AgentMailbox multi-mailbox join, agent hierarchy + per-agent pause,
-- the ProvisioningPolicy RBAC control surface, the MailboxProvisioningRequest
-- approval queue, delegation provenance + provisioning audit kinds. New tables
-- mirror the proven RLS template (CREATE TABLE → indexes → FK → guarded grants →
-- ENABLE+FORCE RLS + workspace_isolation). Column adds on already-fenced tables
-- need no RLS change.

-- ----------------------------------------------------------------------------
-- 1. Extend the audit-kind enum (PG16 allows ADD VALUE in a txn; the new values
--    are not USED in this migration, so same-txn use is not a concern)
-- ----------------------------------------------------------------------------

ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'MAILBOX_CREATED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'MAILBOX_UPDATED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'MAILBOX_ACCESS_GRANTED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'MAILBOX_ACCESS_REVOKED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'AGENT_CREATED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'AGENT_UPDATED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'AUTONOMY_CHANGED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'PROVISION_REQUESTED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'PROVISION_APPROVED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'PROVISION_REJECTED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'PROVISION_APPLIED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'PROVISION_FAILED';

-- ----------------------------------------------------------------------------
-- 2. New enum types
-- ----------------------------------------------------------------------------

CREATE TYPE "MailboxOwnerKind" AS ENUM ('HUMAN', 'AGENT', 'SHARED');
CREATE TYPE "MailboxAccessLevel" AS ENUM ('SEND', 'READ', 'BOTH');
CREATE TYPE "MailboxProvisionState" AS ENUM ('REGISTERED', 'PROVISIONING', 'PROVISIONED', 'PROVISION_FAILED');
CREATE TYPE "AgentTier" AS ENUM ('EXECUTIVE', 'DOMAIN_LEAD', 'MANAGER', 'SPECIALIST', 'UNSPECIFIED');
CREATE TYPE "ProvisioningMode" AS ENUM ('OPEN', 'MANAGER', 'ADMIN_ONLY', 'APPROVAL');
CREATE TYPE "ProvisionableKind" AS ENUM ('HUMAN_MAILBOX', 'AGENT_MAILBOX', 'AGENT');
CREATE TYPE "ProvisioningRequestState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED', 'APPLIED', 'FAILED');

-- ----------------------------------------------------------------------------
-- 3. Column adds on already-fenced tables (no RLS change needed)
-- ----------------------------------------------------------------------------

ALTER TABLE "mailbox_accounts"
  ADD COLUMN "ownerKind" "MailboxOwnerKind" NOT NULL DEFAULT 'SHARED',
  ADD COLUMN "ownerKey" TEXT,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'shared',
  ADD COLUMN "provisionState" "MailboxProvisionState" NOT NULL DEFAULT 'REGISTERED';
CREATE INDEX "mailbox_accounts_workspaceId_ownerKind_ownerKey_idx"
  ON "mailbox_accounts"("workspaceId", "ownerKind", "ownerKey");

ALTER TABLE "agents"
  ADD COLUMN "tier" "AgentTier" NOT NULL DEFAULT 'UNSPECIFIED',
  ADD COLUMN "managerAgentKey" TEXT,
  ADD COLUMN "brigadeAgentId" TEXT,
  ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "agents_workspaceId_managerAgentKey_idx"
  ON "agents"("workspaceId", "managerAgentKey");
CREATE INDEX "agents_workspaceId_tier_idx"
  ON "agents"("workspaceId", "tier");

ALTER TABLE "agent_action_events"
  ADD COLUMN "onBehalfOfAgentKey" TEXT;

-- ----------------------------------------------------------------------------
-- 4. agent_mailboxes — the multi-mailbox join (real FKs)
-- ----------------------------------------------------------------------------

CREATE TABLE "agent_mailboxes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "mailboxAccountId" TEXT NOT NULL,
    "access" "MailboxAccessLevel" NOT NULL DEFAULT 'SEND',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_mailboxes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "agent_mailboxes_agentId_mailboxAccountId_key" ON "agent_mailboxes"("agentId", "mailboxAccountId");
CREATE INDEX "agent_mailboxes_workspaceId_idx" ON "agent_mailboxes"("workspaceId");
CREATE INDEX "agent_mailboxes_workspaceId_agentId_idx" ON "agent_mailboxes"("workspaceId", "agentId");
CREATE INDEX "agent_mailboxes_workspaceId_mailboxAccountId_idx" ON "agent_mailboxes"("workspaceId", "mailboxAccountId");
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_mailboxAccountId_fkey"
  FOREIGN KEY ("mailboxAccountId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 5. provisioning_policies — per-workspace RBAC control surface (1:1)
-- ----------------------------------------------------------------------------

CREATE TABLE "provisioning_policies" (
    "workspaceId" TEXT NOT NULL,
    "humanMailboxCreateMode" "ProvisioningMode" NOT NULL DEFAULT 'MANAGER',
    "humanMailboxEditMode" "ProvisioningMode" NOT NULL DEFAULT 'MANAGER',
    "agentMailboxCreateMode" "ProvisioningMode" NOT NULL DEFAULT 'ADMIN_ONLY',
    "agentMailboxEditMode" "ProvisioningMode" NOT NULL DEFAULT 'ADMIN_ONLY',
    "agentCreateMode" "ProvisioningMode" NOT NULL DEFAULT 'MANAGER',
    "agentEditMode" "ProvisioningMode" NOT NULL DEFAULT 'MANAGER',
    "approverMinRole" "WorkspaceRole" NOT NULL DEFAULT 'ADMIN',
    "allowSelfServiceOwnMailbox" BOOLEAN NOT NULL DEFAULT false,
    "maxMailboxesPerWorkspace" INTEGER,
    "maxAgentsPerWorkspace" INTEGER,
    "updatedByUcUid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provisioning_policies_pkey" PRIMARY KEY ("workspaceId")
);
ALTER TABLE "provisioning_policies" ADD CONSTRAINT "provisioning_policies_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 6. mailbox_provisioning_requests — the approval queue
-- ----------------------------------------------------------------------------

CREATE TABLE "mailbox_provisioning_requests" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "ProvisionableKind" NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'CREATE',
    "state" "ProvisioningRequestState" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "targetId" TEXT,
    "summary" TEXT,
    "requestedByUcUid" TEXT,
    "requestedByAgentKey" TEXT,
    "reviewedByUcUid" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "appliedRefId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mailbox_provisioning_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "mailbox_provisioning_requests_workspaceId_idx" ON "mailbox_provisioning_requests"("workspaceId");
CREATE INDEX "mailbox_provisioning_requests_workspaceId_state_createdAt_idx" ON "mailbox_provisioning_requests"("workspaceId", "state", "createdAt");
ALTER TABLE "mailbox_provisioning_requests" ADD CONSTRAINT "mailbox_provisioning_requests_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 7. Grants (guarded — skip if the runtime roles don't exist yet)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_mailboxes" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "provisioning_policies" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mailbox_provisioning_requests" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "agent_mailboxes" TO email_ops_ro;
    GRANT SELECT ON "provisioning_policies" TO email_ops_ro;
    GRANT SELECT ON "mailbox_provisioning_requests" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 8. RLS — ENABLE + FORCE + workspace_isolation (same predicate as the rest)
-- ----------------------------------------------------------------------------

ALTER TABLE "agent_mailboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_mailboxes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "agent_mailboxes";
CREATE POLICY workspace_isolation ON "agent_mailboxes"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

ALTER TABLE "provisioning_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provisioning_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "provisioning_policies";
CREATE POLICY workspace_isolation ON "provisioning_policies"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

ALTER TABLE "mailbox_provisioning_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailbox_provisioning_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "mailbox_provisioning_requests";
CREATE POLICY workspace_isolation ON "mailbox_provisioning_requests"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

-- ----------------------------------------------------------------------------
-- 9. Backfill: every agent with a primary send mailbox gets its AgentMailbox row
--    (BOTH access, primary). gen_random_uuid() is built-in on PG13+.
-- ----------------------------------------------------------------------------

INSERT INTO "agent_mailboxes" ("id", "workspaceId", "agentId", "mailboxAccountId", "access", "isPrimary", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, a."workspaceId", a."id", a."mailboxAccountId", 'BOTH', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "agents" a
WHERE a."mailboxAccountId" IS NOT NULL;
