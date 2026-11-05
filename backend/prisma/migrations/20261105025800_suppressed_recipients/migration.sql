-- Workspace suppression records and one-click unsubscribe tokens.
-- Token values are never stored: only SHA-256 token hashes are persisted.

CREATE TYPE "SuppressedRecipientReason" AS ENUM (
  'UNSUBSCRIBED',
  'BOUNCED',
  'COMPLAINT',
  'MANUAL'
);

CREATE TABLE "suppressed_recipients" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "reason" "SuppressedRecipientReason" NOT NULL,
  "source" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "suppressed_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "suppressed_recipients_workspaceId_email_key"
  ON "suppressed_recipients"("workspaceId", "email");
CREATE INDEX "suppressed_recipients_workspaceId_reason_idx"
  ON "suppressed_recipients"("workspaceId", "reason");

ALTER TABLE "suppressed_recipients"
  ADD CONSTRAINT "suppressed_recipients_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "unsubscribe_tokens" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "kitId" TEXT,
  "messageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "usedAt" TIMESTAMP(3),
  CONSTRAINT "unsubscribe_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "unsubscribe_tokens_tokenHash_key"
  ON "unsubscribe_tokens"("tokenHash");
CREATE UNIQUE INDEX "unsubscribe_tokens_workspaceId_email_messageId_key"
  ON "unsubscribe_tokens"("workspaceId", "email", "messageId");
CREATE INDEX "unsubscribe_tokens_workspaceId_email_idx"
  ON "unsubscribe_tokens"("workspaceId", "email");
CREATE INDEX "unsubscribe_tokens_workspaceId_messageId_idx"
  ON "unsubscribe_tokens"("workspaceId", "messageId");

ALTER TABLE "unsubscribe_tokens"
  ADD CONSTRAINT "unsubscribe_tokens_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "unsubscribe_tokens"
  ADD CONSTRAINT "unsubscribe_tokens_kitId_fkey"
  FOREIGN KEY ("kitId") REFERENCES "agent_send_kits"("kitId") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "unsubscribe_tokens"
  ADD CONSTRAINT "unsubscribe_tokens_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "email_messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- Grants are guarded so local/dev databases without the runtime roles migrate.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "suppressed_recipients" TO email_ops_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "unsubscribe_tokens" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "suppressed_recipients" TO email_ops_ro;
    GRANT SELECT ON "unsubscribe_tokens" TO email_ops_ro;
  END IF;
END
$$;

ALTER TABLE "suppressed_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "suppressed_recipients" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "suppressed_recipients";
CREATE POLICY workspace_isolation ON "suppressed_recipients"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());

ALTER TABLE "unsubscribe_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "unsubscribe_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON "unsubscribe_tokens";
CREATE POLICY workspace_isolation ON "unsubscribe_tokens"
  USING ("workspaceId" = current_workspace_id())
  WITH CHECK ("workspaceId" = current_workspace_id());
