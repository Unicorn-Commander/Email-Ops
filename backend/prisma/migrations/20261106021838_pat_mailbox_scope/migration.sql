-- PAT mailbox scope: an empty allowlist preserves the existing workspace-wide
-- behavior; non-empty values are mailbox account ids narrowed again at request
-- time against the caller's current membership/ownership.
ALTER TABLE "personal_access_tokens"
ADD COLUMN "mailboxIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
