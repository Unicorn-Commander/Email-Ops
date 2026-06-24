-- ============================================================================
-- Email-Ops — Junk, Folders & Sender Policy (app-layer spam seams)
-- ============================================================================
--
-- Additive, RLS-inherited, inert until read. Adds the app-layer seams for spam /
-- junk handling that pair with the mail-engine / migration project (the engine
-- does inbound scoring, SPF/DKIM/DMARC, reputation; the app owns the disposition
-- overlay, the sender block/allow list, and the dormant SpamPort verdict fields).
--
-- New tables mirror the proven RLS template (CREATE TABLE → indexes → FK →
-- guarded grants → ENABLE+FORCE RLS + workspace_isolation). Column adds on the
-- already-fenced email_messages table need no RLS change.

-- ----------------------------------------------------------------------------
-- 1. New enum types
-- ----------------------------------------------------------------------------

CREATE TYPE "MessageDisposition" AS ENUM ('INBOX', 'ARCHIVE', 'TRASH', 'SPAM');
CREATE TYPE "SenderPolicyKind" AS ENUM ('BLOCK', 'ALLOW');
CREATE TYPE "SenderPolicyScope" AS ENUM ('ADDRESS', 'DOMAIN');

-- ----------------------------------------------------------------------------
-- 2. Column adds on the already-fenced email_messages table (no RLS change).
--    The SpamPort stamps these once the mail engine produces a verdict; NULL
--    until then (honest — no fiction while the engine is dormant).
-- ----------------------------------------------------------------------------

ALTER TABLE "email_messages"
  ADD COLUMN "spamScore" DOUBLE PRECISION,
  ADD COLUMN "spamVerdict" TEXT;

-- ----------------------------------------------------------------------------
-- 3. thread_dispositions — the folder overlay (Inbox/Archive/Trash/Spam)
-- ----------------------------------------------------------------------------

CREATE TABLE "thread_dispositions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "disposition" "MessageDisposition" NOT NULL DEFAULT 'INBOX',
    "setByUcUid" TEXT,
    "setByAgentKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "thread_dispositions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "thread_dispositions_workspaceId_threadId_key" ON "thread_dispositions"("workspaceId", "threadId");
CREATE INDEX "thread_dispositions_workspaceId_disposition_idx" ON "thread_dispositions"("workspaceId", "disposition");
ALTER TABLE "thread_dispositions" ADD CONSTRAINT "thread_dispositions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 4. sender_policies — the per-workspace block/allow list
-- ----------------------------------------------------------------------------

CREATE TABLE "sender_policies" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "SenderPolicyScope" NOT NULL,
    "pattern" TEXT NOT NULL,
    "kind" "SenderPolicyKind" NOT NULL,
    "reason" TEXT,
    "setByUcUid" TEXT,
    "setByAgentKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sender_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sender_policies_workspaceId_scope_pattern_key" ON "sender_policies"("workspaceId", "scope", "pattern");
CREATE INDEX "sender_policies_workspaceId_kind_idx" ON "sender_policies"("workspaceId", "kind");
ALTER TABLE "sender_policies" ADD CONSTRAINT "sender_policies_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 5. Grants (guarded — skip if the runtime roles don't exist yet)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "thread_dispositions" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sender_policies" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "thread_dispositions" TO email_ops_ro;
    GRANT SELECT ON "sender_policies" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 6. RLS — ENABLE + FORCE + workspace_isolation (same predicate as the rest)
-- ----------------------------------------------------------------------------

ALTER TABLE "thread_dispositions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "thread_dispositions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "thread_dispositions";
CREATE POLICY workspace_isolation ON "thread_dispositions"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

ALTER TABLE "sender_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sender_policies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "sender_policies";
CREATE POLICY workspace_isolation ON "sender_policies"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
