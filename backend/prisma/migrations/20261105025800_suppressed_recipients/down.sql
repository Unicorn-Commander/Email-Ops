-- Guarded rollback for 20261105025800_suppressed_recipients.
-- Suppression and token rows are compliance records; archive/remove them in a
-- maintenance window before running this rollback.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "suppressed_recipients") THEN
    RAISE EXCEPTION 'Cannot roll back recipient suppression: suppression rows remain';
  END IF;
  IF EXISTS (SELECT 1 FROM "unsubscribe_tokens") THEN
    RAISE EXCEPTION 'Cannot roll back recipient suppression: unsubscribe token rows remain';
  END IF;
END
$$;

DROP TABLE "unsubscribe_tokens";
DROP TABLE "suppressed_recipients";
DROP TYPE "SuppressedRecipientReason";

COMMIT;
