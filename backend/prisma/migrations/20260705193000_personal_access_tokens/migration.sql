-- ============================================================================
-- Email-Ops — Personal Access Tokens (agent auth; SUITE-IDENTITY §D9)
-- ============================================================================
--
-- A durable, user-mintable credential (`eo_pat_...`) for the MCP surface (and
-- any other JwtAuthGuard-protected route) so an agent can authenticate without
-- a short-lived uchub JWT. Mirrors the suite-wide PAT pattern already used by
-- Meeting-Ops (`mops_pat_`) / Accounting-Ops (`aops_pat_`).
--
-- Only the sha256 hash of the plaintext token is ever persisted (`tokenHash`,
-- unique + indexed for O(1) lookup on resolve); `tokenPrefix` is a display-only
-- copy of the first 12 chars for UI/list rendering. Revocation is a soft
-- `revokedAt` stamp, never a delete, so audit history survives.
--
-- NOT workspace-scoped: like `users`, this is a global-identity control table
-- (a token belongs to a User, not a Workspace), so it carries no `workspaceId`
-- and is NOT RLS-fenced — same posture as `users`/`workspaces`/`memberships`
-- in 20260603230300_suite_tenancy_rls_roles.

-- ----------------------------------------------------------------------------
-- 1. personal_access_tokens
-- ----------------------------------------------------------------------------

CREATE TABLE "personal_access_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "personal_access_tokens_tokenHash_key" ON "personal_access_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "personal_access_tokens_userId_idx" ON "personal_access_tokens"("userId");

-- AddForeignKey
ALTER TABLE "personal_access_tokens"
  ADD CONSTRAINT "personal_access_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 2. Grants (least-privilege; only if the runtime roles exist) — same
--    non-RLS control-table posture as `users` (5a of the RLS-roles migration).
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "personal_access_tokens" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "personal_access_tokens" TO email_ops_ro;
  END IF;
END
$$;
