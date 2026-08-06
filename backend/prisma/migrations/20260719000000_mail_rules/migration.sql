-- ============================================================================
-- Email-Ops — per-mailbox inbound mail rules (the RULES ENGINE storage)
-- ============================================================================
--
-- Workspace-scoped, RLS-fenced rule rows. "match"/"actions" hold the
-- rule-engine JSON (MatchNode / RuleAction[]) validated at write time;
-- the inbound watcher enumerates enabled rows through systemClient and the
-- applicator's hit-counter write stays fenced through withWorkspace.

CREATE TABLE "mail_rules" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL,
    "match" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastHitAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mail_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mail_rules_mailboxId_enabled_idx"
  ON "mail_rules"("mailboxId", "enabled");

ALTER TABLE "mail_rules" ADD CONSTRAINT "mail_rules_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_rules" ADD CONSTRAINT "mail_rules_mailboxId_fkey"
  FOREIGN KEY ("mailboxId") REFERENCES "mailbox_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grants are guarded so local/dev databases without the runtime roles migrate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_rules" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "mail_rules" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "mail_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "mail_rules";
CREATE POLICY workspace_isolation ON "mail_rules"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
