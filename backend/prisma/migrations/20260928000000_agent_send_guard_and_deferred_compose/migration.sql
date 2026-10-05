-- Additive only: deferred compose metadata and human-approved send kits.
ALTER TABLE "email_messages" ADD COLUMN "sendAt" TIMESTAMP(3);
ALTER TABLE "email_messages" ADD COLUMN "kitId" TEXT;
CREATE INDEX "email_messages_workspaceId_status_sendAt_idx"
  ON "email_messages"("workspaceId", "status", "sendAt");

CREATE TABLE "agent_send_kits" (
  "kitId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "approvedBy" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL,
  "templateSha256" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_send_kits_pkey" PRIMARY KEY ("kitId"),
  CONSTRAINT "agent_send_kits_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_send_kits_workspaceId_expiresAt_idx"
  ON "agent_send_kits"("workspaceId", "expiresAt");

ALTER TABLE "agent_send_kits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_send_kits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "agent_send_kits_workspace_isolation" ON "agent_send_kits"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
