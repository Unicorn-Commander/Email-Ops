-- ----------------------------------------------------------------------------
-- Approval-fidelity: persist the FULL composed payload on email_messages so an
-- APPROVED staged draft sends EXACTLY what the approver reviewed. Before this,
-- cc/bcc/multi-recipient/html/attachments were dropped on approve (the send lane
-- supports them; the SoR row simply never stored them). Additive columns on the
-- already-fenced email_messages table — no RLS change. String[] default to an
-- empty array (Prisma convention); bodyHtml/attachments are NULL when unused.
-- ----------------------------------------------------------------------------

ALTER TABLE "email_messages"
  ADD COLUMN "toAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ccAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "bccAddresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "bodyHtml" TEXT,
  ADD COLUMN "attachments" JSONB;
