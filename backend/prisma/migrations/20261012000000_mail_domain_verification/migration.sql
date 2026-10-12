-- Additive mail-domain verification state and audit event kinds.
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'MAIL_DOMAIN_VERIFICATION_REQUESTED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'MAIL_DOMAIN_VERIFIED';
ALTER TYPE "AgentActionKind" ADD VALUE IF NOT EXISTS 'MAIL_DOMAIN_VERIFICATION_FAILED';

ALTER TABLE "mail_domains"
  ADD COLUMN "verificationToken" TEXT,
  ADD COLUMN "verificationRequestedAt" TIMESTAMP(3),
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "lastVerificationCheckAt" TIMESTAMP(3),
  ADD COLUMN "lastVerificationError" TEXT;
