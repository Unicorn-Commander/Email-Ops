-- ============================================================================
-- Email-Ops Phase 2 — EmailEngagementEvent capture table (RLS-fenced, idempotent)
-- ============================================================================
--
-- Adds the durable, auditable, idempotent capture log for delivery/engagement
-- signals the mail engine reports for a message Email-Ops sent (Postmark is the
-- first provider). The inbound webhook (backend/src/webhooks) maps each Postmark
-- record (Delivery|Open|Click|Bounce|SpamComplaint|SubscriptionChange) → one row
-- here AND advances the owning EmailMessage's status idempotently.
--
-- ADDITIVE / REVERSIBLE (SUITE-IDENTITY quality bar; AGENTS.md rule 5):
--   * A new enum value `EmailMessageStatus.BOUNCED` (append-only; PG17 allows
--     ALTER TYPE ADD VALUE inside the migration transaction because the value is
--     NOT referenced by any DDL in this same migration — it is used only at
--     runtime by the webhook updater).
--   * A new enum `EmailEngagementKind` (the normalized suite vocabulary).
--   * A new scoped table `email_engagement_events`, RLS ENABLE+FORCE-d with the
--     SAME `workspace_isolation` policy + grants as the Phase-1 scoped tables.
--   * A supporting index on `email_messages.providerMessageId` so the webhook's
--     privileged id→workspace resolve is a single-row hit.
--
-- ROLLOUT POSTURE: identical to Phase 1 — RLS is created+FORCED but inert for the
-- running app until the runtime DATABASE_URL flips to the NOBYPASSRLS
-- `email_ops_app` role. The webhook write path always goes through
-- withWorkspace(resolvedWorkspaceId), so it is correct under both the current
-- owner connection and the future fenced role.
--
-- NULL workspace_id handling: `email_engagement_events.workspaceId` is NOT NULL,
-- and the policy predicate `workspaceId = current_workspace_id()` is fail-closed
-- under SQL three-valued logic, exactly like the other scoped tables.

-- ----------------------------------------------------------------------------
-- 1. Enums
-- ----------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "EmailEngagementKind" AS ENUM ('REPLIED', 'CLICKED', 'OPENED', 'BOUNCED', 'UNSUBSCRIBED');

-- AlterEnum
-- Append a terminal deliverability status. Append-only; never used in this
-- migration's DDL (safe inside the transaction on PG12+).
ALTER TYPE "EmailMessageStatus" ADD VALUE 'BOUNCED';

-- ----------------------------------------------------------------------------
-- 2. Table + indexes + foreign keys
-- ----------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "email_engagement_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailMessageId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'postmark',
    "providerEventId" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "normalizedKind" "EmailEngagementKind",
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_engagement_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_engagement_events_workspaceId_idx" ON "email_engagement_events"("workspaceId");

-- CreateIndex
CREATE INDEX "email_engagement_events_workspaceId_emailMessageId_occurred_idx" ON "email_engagement_events"("workspaceId", "emailMessageId", "occurredAt");

-- CreateIndex
-- Idempotency anchor: a webhook re-delivery is a no-op (the second insert hits
-- this unique index and the handler treats it as already-seen).
CREATE UNIQUE INDEX "email_engagement_events_workspaceId_provider_providerEventI_key" ON "email_engagement_events"("workspaceId", "provider", "providerEventId");

-- CreateIndex
-- The webhook resolves a Postmark MessageID → the owning row via this column.
CREATE INDEX "email_messages_providerMessageId_idx" ON "email_messages"("providerMessageId");

-- AddForeignKey
ALTER TABLE "email_engagement_events" ADD CONSTRAINT "email_engagement_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_engagement_events" ADD CONSTRAINT "email_engagement_events_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "email_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. GRANTS — least privilege, mirroring the Phase-1 RLS migration §5b.
--    The new scoped table gets full DML for the runtime app role (RLS fences
--    the rows). The owner already owns it (migration runner is a member of
--    email_ops_owner), and the Phase-1 ALTER DEFAULT PRIVILEGES already covers
--    owner-created tables — but we GRANT explicitly so this migration is correct
--    even if applied by a role that predates those defaults. The role may not
--    exist on a fresh shadow DB (the role-creation migration ran first in a real
--    deploy); guard each grant so the migration is safe on any cluster.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "email_engagement_events" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "email_engagement_events" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY — ENABLE + FORCE + the workspace_isolation policy,
--    IDENTICAL to the Phase-1 RLS migration §6 (same USING + WITH CHECK on
--    `workspaceId = current_workspace_id()`). FORCE so the owner is subject to
--    policy too; the runtime role is non-owner + NOBYPASSRLS regardless.
-- ----------------------------------------------------------------------------
ALTER TABLE "email_engagement_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_engagement_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "email_engagement_events";
CREATE POLICY workspace_isolation ON "email_engagement_events"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
