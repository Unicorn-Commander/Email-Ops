-- Rollback for 20261103190000_send_kit_expiry_lifecycle.
-- The new states/actions cannot be represented by the prior enums. Refuse a
-- rollback that would silently discard lifecycle data; archive or remove the
-- affected rows first, then run this file in a maintenance window.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "agent_send_kits" WHERE "state"::text IN ('EXPIRED', 'RETURNED', 'SUPERSEDED')) THEN
    RAISE EXCEPTION 'Cannot roll back send-kit lifecycle: new state rows remain';
  END IF;
  IF EXISTS (SELECT 1 FROM "agent_action_events" WHERE "kind"::text IN ('SEND_KIT_EXTENDED', 'SEND_KIT_REPROPOSED', 'SEND_KIT_RETURNED')) THEN
    RAISE EXCEPTION 'Cannot roll back send-kit lifecycle: new audit rows remain';
  END IF;
END
$$;

DROP INDEX "agent_send_kits_workspaceId_supersededByKitId_idx";
ALTER TABLE "agent_send_kits"
  DROP COLUMN "expiredFromState",
  DROP COLUMN "returnNote",
  DROP COLUMN "returnedBy",
  DROP COLUMN "returnedAt",
  DROP COLUMN "supersededByKitId";

CREATE TYPE "AgentSendKitState_old" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');
ALTER TABLE "agent_send_kits"
  ALTER COLUMN "state" TYPE "AgentSendKitState_old"
  USING ("state"::text::"AgentSendKitState_old");
DROP TYPE "AgentSendKitState";
ALTER TYPE "AgentSendKitState_old" RENAME TO "AgentSendKitState";

CREATE TYPE "AgentActionKind_old" AS ENUM (
  'AUTONOMOUS_SEND',
  'STAGED_FOR_APPROVAL',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'RESUMED',
  'MAILBOX_CREATED',
  'MAILBOX_UPDATED',
  'MAILBOX_ACCESS_GRANTED',
  'MAILBOX_ACCESS_REVOKED',
  'AGENT_CREATED',
  'AGENT_UPDATED',
  'AUTONOMY_CHANGED',
  'PROVISION_REQUESTED',
  'PROVISION_APPROVED',
  'PROVISION_REJECTED',
  'PROVISION_APPLIED',
  'PROVISION_FAILED',
  'MAIL_DOMAIN_VERIFICATION_REQUESTED',
  'MAIL_DOMAIN_VERIFIED',
  'MAIL_DOMAIN_VERIFICATION_FAILED'
);
ALTER TABLE "agent_action_events"
  ALTER COLUMN "kind" TYPE "AgentActionKind_old"
  USING ("kind"::text::"AgentActionKind_old");
DROP TYPE "AgentActionKind";
ALTER TYPE "AgentActionKind_old" RENAME TO "AgentActionKind";

COMMIT;
