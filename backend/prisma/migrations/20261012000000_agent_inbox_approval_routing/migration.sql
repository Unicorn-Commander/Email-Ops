-- Email-Ops — deterministic agent-inbox approval routing
--
-- Numeric commercial terms and configured approval keywords require a workspace
-- owner/admin. Existing rows default to the mailbox-owner tier so this additive
-- change does not make previously staged routine drafts stricter retroactively.

CREATE TYPE "AgentInboxApprovalTier" AS ENUM ('OWNER_ADMIN', 'MAILBOX_OWNER');

ALTER TABLE "workspaces"
  ADD COLUMN "approvalKeywords" JSONB;

ALTER TABLE "agent_inbox_items"
  ADD COLUMN "approvalTier" "AgentInboxApprovalTier" NOT NULL DEFAULT 'MAILBOX_OWNER',
  ADD COLUMN "approvalReason" TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "agent_inbox_items" TO email_ops_app;
    GRANT SELECT, UPDATE ON "workspaces" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "agent_inbox_items" TO email_ops_ro;
    GRANT SELECT ON "workspaces" TO email_ops_ro;
  END IF;
END
$$;
