-- Inbound watcher high-water mark per sovereign mailbox (the ISO receivedAt of
-- the newest inbox message already processed). Additive nullable column on the
-- already-fenced mailbox_accounts table — no RLS change. NULL until first baseline.

ALTER TABLE "mailbox_accounts" ADD COLUMN "inboundCursor" TEXT;
