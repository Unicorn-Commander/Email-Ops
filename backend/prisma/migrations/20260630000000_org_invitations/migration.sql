-- ============================================================================
-- Email-Ops — Org invitations (the create-org → invite-users layer)
-- ============================================================================
--
-- An Invitation is a pending grant into a workspace. Like `memberships` and
-- `workspaces`, it is a CONTROL/IDENTITY table — deliberately NOT RLS-fenced:
--   - accept-by-token has no workspace context (the token IS the authorization);
--   - list-mine spans every workspace the caller was invited to.
-- The admin surface (list/create/revoke within an org) is fenced in app code by
-- the caller's ACTUAL membership role (resolved per request), which is the real
-- fence regardless of the EMAIL_OPS_TENANCY_ENABLED flag. `email` is stored
-- lowercased so the invitee match is case-insensitive.

-- ----------------------------------------------------------------------------
-- 1. Enum (the invitation lifecycle)
-- ----------------------------------------------------------------------------

CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- ----------------------------------------------------------------------------
-- 2. invitations — a pending grant into a workspace
-- ----------------------------------------------------------------------------

CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedByKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedByKey" TEXT,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_token_key" ON "invitations"("token");
CREATE INDEX "invitations_workspaceId_idx" ON "invitations"("workspaceId");
CREATE INDEX "invitations_email_idx" ON "invitations"("email");
CREATE INDEX "invitations_token_idx" ON "invitations"("token");

ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 3. Grants (least-privilege; only if the runtime roles exist). NO RLS — this is
--    a control table in the same class as workspaces + memberships.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "invitations" TO email_ops_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    GRANT SELECT ON "invitations" TO email_ops_ro;
  END IF;
END
$$;
