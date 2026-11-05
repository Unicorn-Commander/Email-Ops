-- Store workspace invitation capabilities as one-way SHA-256 hashes.
-- Existing raw tokens are hashed before the cleartext column is removed so
-- already-delivered links remain valid until their existing expiry.
BEGIN;

ALTER TABLE "invitations" ADD COLUMN "tokenHash" TEXT;

UPDATE "invitations"
SET "tokenHash" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "tokenHash" IS NULL;

ALTER TABLE "invitations"
  ALTER COLUMN "tokenHash" SET NOT NULL;

CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

DROP INDEX "invitations_token_key";
DROP INDEX "invitations_token_idx";
ALTER TABLE "invitations" DROP COLUMN "token";

COMMIT;
