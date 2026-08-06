-- ============================================================================
-- Email-Ops — Unified Inbox: mail backend provider on a mailbox
-- ============================================================================
--
-- Additive, RLS-inherited, inert until read. Adds which mail backend fronts a
-- mailbox: 'stalwart' (the sovereign engine — the back-compat default for every
-- existing row) or an EXTERNAL connected account read/sent through its provider
-- API + the Keycloak broker token ('gmail' | 'microsoft'). A column-add on the
-- already-fenced mailbox_accounts table needs no RLS change.

ALTER TABLE "mailbox_accounts"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stalwart';
