-- Add scoped, expiring PAT credentials without invalidating existing tokens.
ALTER TABLE "personal_access_tokens"
  ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Existing PATs predate scopes and retain their full-access behavior.
UPDATE "personal_access_tokens"
SET "scopes" = ARRAY['*']::TEXT[];
