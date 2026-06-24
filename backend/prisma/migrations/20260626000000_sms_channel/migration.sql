-- ============================================================================
-- Email-Ops — SMS channel (the enterprise/shared-line scope; Twilio + in-house roadmap)
-- ============================================================================
--
-- Additive + DORMANT. Adds an SMS send/receive SoR that reuses the EXISTING
-- governance: the autonomy dial (Agent.autonomyLevel + decideComposeMode), the
-- kill switch (Workspace.agentsPaused), the agent-inbox approval queue, and the
-- AgentActionEvent audit log — an SMS send flows through the same path as email.
--
-- NO destructive change: email_messages is untouched; agent_inbox_items gains one
-- nullable column (smsMessageId) so an SMS draft can stage in the same queue
-- (email items keep using messageId). New tables mirror the proven RLS template
-- (CREATE TABLE → indexes → FK → guarded grants → ENABLE+FORCE RLS +
-- workspace_isolation). No new audit-kind enum values — AUTONOMOUS_SEND /
-- STAGED_FOR_APPROVAL are channel-neutral.

-- ----------------------------------------------------------------------------
-- 1. New enum types (the SMS send/draft + delivery lifecycle)
-- ----------------------------------------------------------------------------

CREATE TYPE "SmsMode" AS ENUM ('SEND', 'DRAFT');
CREATE TYPE "SmsDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'PENDING_APPROVAL', 'REJECTED', 'FAILED');

-- ----------------------------------------------------------------------------
-- 2. sms_accounts — the workspace's outbound SMS identity (mirrors mailbox_accounts)
-- ----------------------------------------------------------------------------

CREATE TABLE "sms_accounts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "displayName" TEXT,
    "secretRef" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "ownerKind" "MailboxOwnerKind" NOT NULL DEFAULT 'SHARED',
    "ownerKey" TEXT,
    "provisionState" "MailboxProvisionState" NOT NULL DEFAULT 'REGISTERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sms_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sms_accounts_workspaceId_phoneNumber_key" ON "sms_accounts"("workspaceId", "phoneNumber");
CREATE INDEX "sms_accounts_workspaceId_idx" ON "sms_accounts"("workspaceId");
CREATE INDEX "sms_accounts_workspaceId_isDefault_idx" ON "sms_accounts"("workspaceId", "isDefault");
CREATE INDEX "sms_accounts_workspaceId_ownerKind_ownerKey_idx" ON "sms_accounts"("workspaceId", "ownerKind", "ownerKey");
ALTER TABLE "sms_accounts" ADD CONSTRAINT "sms_accounts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. sms_messages — the SMS SoR (mirrors email_messages incl. the partial
--    idempotency unique index for the NULL source/ref case)
-- ----------------------------------------------------------------------------

CREATE TABLE "sms_messages" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "smsAccountId" TEXT,
    "contactId" TEXT,
    "threadId" TEXT,
    "externalSource" TEXT,
    "externalRef" TEXT,
    "mode" "SmsMode" NOT NULL DEFAULT 'SEND',
    "status" "SmsDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "direction" TEXT NOT NULL DEFAULT 'SENT',
    "fromPhoneNumber" TEXT,
    "toPhoneNumber" TEXT,
    "body" TEXT,
    "preview" TEXT,
    "providerMessageId" TEXT,
    "actorUcUid" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sms_messages_pkey" PRIMARY KEY ("id")
);
-- Idempotency: unique per workspace, partial on the non-null source/ref (mirrors
-- email_messages; Prisma maps the @@unique to this index name).
CREATE UNIQUE INDEX "sms_messages_workspaceId_externalSource_externalRef_key"
  ON "sms_messages"("workspaceId", "externalSource", "externalRef")
  WHERE "externalSource" IS NOT NULL AND "externalRef" IS NOT NULL;
CREATE INDEX "sms_messages_providerMessageId_idx" ON "sms_messages"("providerMessageId");
CREATE INDEX "sms_messages_workspaceId_idx" ON "sms_messages"("workspaceId");
CREATE INDEX "sms_messages_workspaceId_contactId_createdAt_idx" ON "sms_messages"("workspaceId", "contactId", "createdAt");
CREATE INDEX "sms_messages_workspaceId_threadId_idx" ON "sms_messages"("workspaceId", "threadId");
CREATE INDEX "sms_messages_workspaceId_status_idx" ON "sms_messages"("workspaceId", "status");
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sms_messages" ADD CONSTRAINT "sms_messages_smsAccountId_fkey"
  FOREIGN KEY ("smsAccountId") REFERENCES "sms_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 4. agent_inbox_items.smsMessageId — additive column on an already-fenced table
--    (no RLS change; an SMS draft stages here, email items keep using messageId)
-- ----------------------------------------------------------------------------

ALTER TABLE "agent_inbox_items" ADD COLUMN "smsMessageId" TEXT;
CREATE UNIQUE INDEX "agent_inbox_items_smsMessageId_key" ON "agent_inbox_items"("smsMessageId");
ALTER TABLE "agent_inbox_items" ADD CONSTRAINT "agent_inbox_items_smsMessageId_fkey"
  FOREIGN KEY ("smsMessageId") REFERENCES "sms_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 5. Grants (guarded — skip if the runtime roles don't exist yet)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sms_accounts" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sms_messages" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "sms_accounts" TO email_ops_ro;
    GRANT SELECT ON "sms_messages" TO email_ops_ro;
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 6. RLS — ENABLE + FORCE + workspace_isolation (same predicate as the rest)
-- ----------------------------------------------------------------------------

ALTER TABLE "sms_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sms_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "sms_accounts";
CREATE POLICY workspace_isolation ON "sms_accounts"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

ALTER TABLE "sms_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sms_messages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "sms_messages";
CREATE POLICY workspace_isolation ON "sms_messages"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
