-- Raw invitation capabilities cannot be reconstructed from SHA-256 hashes.
-- Refuse rollback while any invitation row exists rather than inventing a
-- replacement token or silently invalidating a pending email link.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "invitations") THEN
    RAISE EXCEPTION 'Cannot roll back invitation token hashing while invitation rows exist';
  END IF;
END
$$;

DROP INDEX "invitations_tokenHash_key";
ALTER TABLE "invitations" DROP COLUMN "tokenHash";
ALTER TABLE "invitations" ADD COLUMN "token" TEXT NOT NULL;
CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");
CREATE INDEX "invitations_token_idx" ON "invitations"("token");

COMMIT;
