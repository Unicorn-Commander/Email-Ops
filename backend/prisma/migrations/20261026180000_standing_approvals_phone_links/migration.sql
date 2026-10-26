-- Additive campaign grants, atomic send reservations and human approval links.
CREATE TABLE "standing_approvals" (
  "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "campaignKey" TEXT NOT NULL, "mailboxId" TEXT NOT NULL REFERENCES "mailbox_accounts"("id") ON DELETE RESTRICT,
  "fromAddress" TEXT NOT NULL, "templateSha256" TEXT NOT NULL,
  "bodyTemplate" TEXT NOT NULL, "placeholderRules" JSONB NOT NULL,
  "optionalLines" JSONB NOT NULL, "subjects" TEXT[] NOT NULL,
  "recipientRules" JSONB NOT NULL, "capPerDay" INTEGER NOT NULL CHECK ("capPerDay" > 0),
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedBy" TEXT, "approvedAt" TIMESTAMP(3), "revokedBy" TEXT, "revokedAt" TIMESTAMP(3),
  CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '90 days'),
  CHECK (("approvedAt" IS NULL) = ("approvedBy" IS NULL)),
  CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL))
);
CREATE INDEX "standing_approvals_workspaceId_mailboxId_expiresAt_idx" ON "standing_approvals"("workspaceId", "mailboxId", "expiresAt");
CREATE INDEX "standing_approvals_workspaceId_campaignKey_idx" ON "standing_approvals"("workspaceId", "campaignKey");
CREATE UNIQUE INDEX "standing_approvals_one_active_campaign" ON "standing_approvals"("workspaceId", "campaignKey") WHERE "approvedAt" IS NOT NULL AND "revokedAt" IS NULL;
ALTER TABLE "email_messages" ADD COLUMN "standingApprovalId" TEXT REFERENCES "standing_approvals"("id") ON DELETE RESTRICT;
CREATE TABLE "standing_approval_uses" (
  "messageId" TEXT PRIMARY KEY REFERENCES "email_messages"("id") ON DELETE CASCADE,
  "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "approvalId" TEXT NOT NULL REFERENCES "standing_approvals"("id") ON DELETE RESTRICT,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "standing_approval_uses_workspaceId_approvalId_reservedAt_idx" ON "standing_approval_uses"("workspaceId", "approvalId", "reservedAt");
CREATE TABLE "approval_links" (
  "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('send-kit', 'standing')), "targetId" TEXT NOT NULL,
  "definitionSha256" TEXT NOT NULL, "recipientSha256" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("expiresAt" <= "createdAt" + INTERVAL '24 hours')
);
CREATE INDEX "approval_links_workspaceId_kind_targetId_idx" ON "approval_links"("workspaceId", "kind", "targetId");
CREATE TABLE "approval_sessions" (
  "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("expiresAt" <= "createdAt" + INTERVAL '30 days')
);
CREATE INDEX "approval_sessions_workspaceId_userId_idx" ON "approval_sessions"("workspaceId", "userId");

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['standing_approvals', 'standing_approval_uses', 'approval_links', 'approval_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY workspace_isolation ON %I USING ("workspaceId" = current_workspace_id()) WITH CHECK ("workspaceId" = current_workspace_id())', table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO email_ops_app', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
      EXECUTE format('GRANT SELECT ON %I TO email_ops_ro', table_name);
    END IF;
  END LOOP;
END $$;
