-- Additive send-kit proposal lifecycle. Legacy rows are already human-approved;
-- their raw recipients cannot be reconstructed from the L1b recipient hashes, so
-- they receive an empty retained-recipient list while keeping their hashes.
CREATE TYPE "AgentSendKitState" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

ALTER TABLE "agent_send_kits"
  ADD COLUMN "state" "AgentSendKitState" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "title" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "proposedBy" TEXT,
  ADD COLUMN "proposedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedBy" TEXT,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "note" TEXT,
  ADD COLUMN "recipients" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "agent_send_kits"
  ALTER COLUMN "approvedBy" DROP NOT NULL,
  ALTER COLUMN "approvedAt" DROP NOT NULL;

UPDATE "agent_send_kits"
SET "title" = "kitId"
WHERE "title" = '';

CREATE INDEX "agent_send_kits_workspaceId_state_idx"
  ON "agent_send_kits"("workspaceId", "state");
