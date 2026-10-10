-- Per-member mailbox visibility. Existing memberships retain the legacy
-- workspace-wide behavior through the ALL default.
CREATE TYPE "MailboxScope" AS ENUM ('ALL', 'OWNED');

ALTER TABLE "memberships"
  ADD COLUMN "mailboxScope" "MailboxScope" NOT NULL DEFAULT 'ALL';
