-- Preserve the canonical Email-Ops workspace when Ops-Center org and workspace
-- ids differ. NULL keeps native/non-entitled workspaces out of this mapping.
ALTER TABLE "workspaces"
  ADD COLUMN "opsCenterOrgId" TEXT;

CREATE UNIQUE INDEX "workspaces_opsCenterOrgId_key"
  ON "workspaces"("opsCenterOrgId");
