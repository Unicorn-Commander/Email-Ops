-- Email-Ops mail-rule notices and sovereign forward idempotency.

ALTER TYPE "AgentInboxKind" ADD VALUE 'NOTICE';

CREATE TABLE "mail_rule_forwards" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mail_rule_forwards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mail_rule_forwards_ruleId_messageId_key"
  ON "mail_rule_forwards"("ruleId", "messageId");
CREATE INDEX "mail_rule_forwards_workspaceId_idx"
  ON "mail_rule_forwards"("workspaceId");
CREATE INDEX "mail_rule_forwards_workspaceId_ruleId_idx"
  ON "mail_rule_forwards"("workspaceId", "ruleId");

ALTER TABLE "mail_rule_forwards" ADD CONSTRAINT "mail_rule_forwards_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mail_rule_forwards" ADD CONSTRAINT "mail_rule_forwards_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "mail_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "mail_rule_forwards" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "mail_rule_forwards" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "mail_rule_forwards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mail_rule_forwards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "mail_rule_forwards";
CREATE POLICY workspace_isolation ON "mail_rule_forwards"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
