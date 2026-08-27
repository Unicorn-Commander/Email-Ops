-- Postmark lane becomes explicit opt-in: new mailboxes default to the sovereign James lane.
ALTER TABLE "mailbox_accounts" ALTER COLUMN "postmarkLane" SET DEFAULT false;
