-- Additive personalised send-kit definition. Existing kit rows receive an
-- intentionally unusable empty definition; no old narrow hash can authorize a
-- new personalised agent send.
ALTER TABLE "agent_send_kits"
  ADD COLUMN "bodyTemplate" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "placeholderRules" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "optionalLines" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "subjects" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "recipientHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "fromAddress" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "capPerDay" INTEGER NOT NULL DEFAULT 0;
