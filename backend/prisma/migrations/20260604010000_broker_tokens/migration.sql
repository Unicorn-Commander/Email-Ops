-- ============================================================================
-- Email-Ops Phase 3d — broker-token storage for Keycloak refresh tokens
-- ============================================================================
--
-- The connected-account OAuth dance and provider-token vault are superseded by
-- Keycloak brokered IdP tokens. The only persisted secret is the user's
-- encrypted Keycloak refresh token on the global User row. The tenant-scoped
-- connected_accounts table is removed.

-- ----------------------------------------------------------------------------
-- 1. User refresh-token columns
-- ----------------------------------------------------------------------------

ALTER TABLE "users"
  ADD COLUMN "kcRefreshTokenEnc" TEXT,
  ADD COLUMN "kcRefreshUpdatedAt" TIMESTAMP(3);

-- ----------------------------------------------------------------------------
-- 2. Drop the superseded per-account vault table
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS "connected_accounts";
