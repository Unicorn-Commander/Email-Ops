-- Send-kit expiry lifecycle and human return/re-proposal metadata.
-- EXPIRED is materialized by EmailService on reads for PROPOSED/APPROVED rows;
-- expiredFromState lets EXTEND restore the pre-expiry approval state.
ALTER TYPE "AgentSendKitState" ADD VALUE 'EXPIRED';
ALTER TYPE "AgentSendKitState" ADD VALUE 'RETURNED';
ALTER TYPE "AgentSendKitState" ADD VALUE 'SUPERSEDED';

ALTER TYPE "AgentActionKind" ADD VALUE 'SEND_KIT_EXTENDED';
ALTER TYPE "AgentActionKind" ADD VALUE 'SEND_KIT_REPROPOSED';
ALTER TYPE "AgentActionKind" ADD VALUE 'SEND_KIT_RETURNED';

ALTER TABLE "agent_send_kits"
  ADD COLUMN "expiredFromState" "AgentSendKitState",
  ADD COLUMN "returnNote" TEXT,
  ADD COLUMN "returnedBy" TEXT,
  ADD COLUMN "returnedAt" TIMESTAMP(3),
  ADD COLUMN "supersededByKitId" TEXT;

CREATE INDEX "agent_send_kits_workspaceId_supersededByKitId_idx"
  ON "agent_send_kits"("workspaceId", "supersededByKitId");
