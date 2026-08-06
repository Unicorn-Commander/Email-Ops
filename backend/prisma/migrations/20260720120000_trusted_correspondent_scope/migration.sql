-- ============================================================================
-- Email-Ops Wave 10 — domain-level trust (TrustedCorrespondent.scope)
-- ============================================================================
--
-- Trust was address-exact: to trust a whole client org you approved every
-- person one-by-one. Add a DOMAIN scope (mirrors SenderPolicy's ADDRESS|DOMAIN):
-- an ADDRESS row trusts one address (jane@acme.com); a DOMAIN row trusts every
-- address at a bare domain (acme.com). The autonomy gate's ROUTINE check counts
-- a recipient as trusted if its full address OR its domain is trusted.
--
-- Existing rows are ADDRESS (the column default backfills them). The unique key
-- moves from (workspaceId, address) to (workspaceId, scope, address) so an
-- explicit address AND its domain can both be trusted without collision.

CREATE TYPE "TrustedCorrespondentScope" AS ENUM ('ADDRESS', 'DOMAIN');

ALTER TABLE "trusted_correspondents"
  ADD COLUMN "scope" "TrustedCorrespondentScope" NOT NULL DEFAULT 'ADDRESS';

DROP INDEX IF EXISTS "trusted_correspondents_workspaceId_address_key";
CREATE UNIQUE INDEX "trusted_correspondents_workspaceId_scope_address_key"
  ON "trusted_correspondents"("workspaceId", "scope", "address");
