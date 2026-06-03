-- ============================================================================
-- Email-Ops Phase 1 — RLS acceptance proof (run AS email_ops_app)
-- ============================================================================
-- Re-proves the tenant fence on EVERY scoped table (mailbox_accounts,
-- email_messages, agent_inbox_items) as the NOBYPASSRLS runtime role. Connect:
--
--   PGPASSWORD=verify_app /opt/homebrew/bin/psql \
--     "postgresql://email_ops_app@localhost:55444/emailops" \
--     -v ON_ERROR_STOP=0 -f prisma/rls-acceptance.sql
--
-- Expectations (asserted inline):
--   A. role posture: rolbypassrls = f  (NOBYPASSRLS — the fence is live for it)
--   B. FORCE + ENABLE on all three scoped tables = t/t
--   C. no-GUC reads on all three tables = 0 rows (fail-closed)
--   D. seed two workspaces' rows under their own GUC, then prove cross-read = 0
--      (incl. an agent_inbox_item per workspace)
--   E. WITH CHECK blocks writing a row into a workspace other than the GUC's
--      (mailbox_accounts, email_messages, AND agent_inbox_items)
--   F. UPDATE/DELETE across the fence are no-ops (0 rows)

\echo '==================================================================='
\echo 'A. Runtime role posture (MUST be email_ops_app, rolbypassrls = f)'
\echo '==================================================================='
SELECT current_user, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

\echo ''
\echo '==================================================================='
\echo 'B. ENABLE + FORCE row security on all three scoped tables (t/t)'
\echo '==================================================================='
SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
FROM pg_class
WHERE relname IN ('mailbox_accounts', 'email_messages', 'agent_inbox_items')
ORDER BY relname;

\echo ''
\echo '==================================================================='
\echo 'C. No-GUC reads MUST return 0 rows (fail-closed; no workspace set)'
\echo '==================================================================='
SELECT 'mailbox_accounts' AS tbl, count(*) AS no_guc_rows FROM mailbox_accounts
UNION ALL
SELECT 'email_messages', count(*) FROM email_messages
UNION ALL
SELECT 'agent_inbox_items', count(*) FROM agent_inbox_items;

\echo ''
\echo '==================================================================='
\echo 'D. Seed two workspaces under their own GUC, then prove isolation.'
\echo '   (Workspaces are inserted by the BYPASSRLS owner in the harness;'
\echo '    here as the app role we write the SCOPED rows under each GUC.)'
\echo '==================================================================='

-- --- Workspace AAAA -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
SELECT set_config('app.uc_uid', 'uc-uid-alice', true);
INSERT INTO mailbox_accounts (id, "workspaceId", "emailAddress", "isDefault", "postmarkLane", active, "createdAt", "updatedAt")
VALUES ('mbx-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'desk-aaaa@magicunicorn.tech', true, true, true, now(), now());
INSERT INTO email_messages (id, "workspaceId", "contactId", "threadId", "externalSource", "externalRef", mode, status, direction, "toAddress", subject, "createdAt", "updatedAt")
VALUES ('msg-aaaa-1', '0190a000-7e57-7000-8000-0000000eaaaa', 'contact-aaaa', 'thread-aaaa', 'customer-ops', 'ref-aaaa-1', 'DRAFT', 'PENDING_APPROVAL', 'DRAFT', 'lead-aaaa@acme.test', 'Hi AAAA', now(), now());
INSERT INTO agent_inbox_items (id, "workspaceId", "messageId", state, "draftedBy", summary, "createdAt", "updatedAt")
VALUES ('inbox-aaaa-1', '0190a000-7e57-7000-8000-0000000eaaaa', 'msg-aaaa-1', 'PENDING', 'customer-ops', 'Hi AAAA → lead-aaaa@acme.test', now(), now());
\echo '-- under GUC=AAAA, I can see only my own rows:'
SELECT count(*) AS aaaa_mailboxes FROM mailbox_accounts;
SELECT count(*) AS aaaa_messages FROM email_messages;
SELECT count(*) AS aaaa_inbox FROM agent_inbox_items;
COMMIT;

-- --- Workspace BBBB -------------------------------------------------------
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000ebbbb', true);
SELECT set_config('app.uc_uid', 'uc-uid-bob', true);
INSERT INTO mailbox_accounts (id, "workspaceId", "emailAddress", "isDefault", "postmarkLane", active, "createdAt", "updatedAt")
VALUES ('mbx-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'desk-bbbb@magicunicorn.tech', true, true, true, now(), now());
INSERT INTO email_messages (id, "workspaceId", "contactId", "threadId", "externalSource", "externalRef", mode, status, direction, "toAddress", subject, "createdAt", "updatedAt")
VALUES ('msg-bbbb-1', '0190a000-7e57-7000-8000-0000000ebbbb', 'contact-bbbb', 'thread-bbbb', 'customer-ops', 'ref-bbbb-1', 'SEND', 'SENT', 'SENT', 'lead-bbbb@acme.test', 'Hi BBBB', now(), now());
INSERT INTO agent_inbox_items (id, "workspaceId", "messageId", state, "draftedBy", summary, "createdAt", "updatedAt")
VALUES ('inbox-bbbb-1', '0190a000-7e57-7000-8000-0000000ebbbb', 'msg-bbbb-1', 'PENDING', 'customer-ops', 'Hi BBBB → lead-bbbb@acme.test', now(), now());
\echo '-- under GUC=BBBB, I can see only BBBB rows (AAAA invisible):'
SELECT count(*) AS bbbb_mailboxes FROM mailbox_accounts;
SELECT count(*) AS bbbb_messages FROM email_messages;
SELECT count(*) AS bbbb_inbox FROM agent_inbox_items;
\echo '-- explicit cross-read: AAAA rows from BBBB context MUST be 0:'
SELECT count(*) AS aaaa_msg_visible_from_bbbb FROM email_messages WHERE id = 'msg-aaaa-1';
SELECT count(*) AS aaaa_mbx_visible_from_bbbb FROM mailbox_accounts WHERE id = 'mbx-aaaa';
SELECT count(*) AS aaaa_inbox_visible_from_bbbb FROM agent_inbox_items WHERE id = 'inbox-aaaa-1';
COMMIT;

\echo ''
\echo '==================================================================='
\echo 'E. WITH CHECK blocks writing into another workspace than the GUC.'
\echo '   Bound to AAAA, try to INSERT rows tagged BBBB -> each MUST error'
\echo '   (new row violates row-level security policy).'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
\echo '-- E1: cross-write a mailbox_account -> MUST raise:'
INSERT INTO mailbox_accounts (id, "workspaceId", "emailAddress", "isDefault", "postmarkLane", active, "createdAt", "updatedAt")
VALUES ('mbx-evil', '0190a000-7e57-7000-8000-0000000ebbbb', 'evil@x.test', false, true, true, now(), now());
ROLLBACK;

BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
\echo '-- E2: cross-write an email_message -> MUST raise:'
INSERT INTO email_messages (id, "workspaceId", "externalSource", "externalRef", mode, status, direction, "toAddress", "createdAt", "updatedAt")
VALUES ('msg-evil', '0190a000-7e57-7000-8000-0000000ebbbb', 'customer-ops', 'ref-evil', 'SEND', 'QUEUED', 'SENT', 'evil@x.test', now(), now());
ROLLBACK;

BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
\echo '-- E3: cross-write an agent_inbox_item -> MUST raise:'
INSERT INTO agent_inbox_items (id, "workspaceId", "messageId", state, "createdAt", "updatedAt")
VALUES ('inbox-evil', '0190a000-7e57-7000-8000-0000000ebbbb', 'msg-bbbb-1', 'PENDING', now(), now());
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'F. UPDATE/DELETE across the fence are no-ops (0 rows) from AAAA.'
\echo '   Bound to AAAA, try to mutate BBBB rows -> 0 rows affected.'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
\echo '-- UPDATE BBBB message from AAAA (expect UPDATE 0):'
UPDATE email_messages SET status = 'FAILED' WHERE id = 'msg-bbbb-1';
\echo '-- DELETE BBBB inbox item from AAAA (expect DELETE 0):'
DELETE FROM agent_inbox_items WHERE id = 'inbox-bbbb-1';
\echo '-- DELETE BBBB mailbox from AAAA (expect DELETE 0):'
DELETE FROM mailbox_accounts WHERE id = 'mbx-bbbb';
ROLLBACK;

\echo ''
\echo '==================================================================='
\echo 'CLEANUP — remove seeded scoped rows (each under its own GUC).'
\echo '==================================================================='
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
DELETE FROM agent_inbox_items WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000eaaaa';
DELETE FROM email_messages WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000eaaaa';
DELETE FROM mailbox_accounts WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000eaaaa';
COMMIT;
BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000ebbbb', true);
DELETE FROM agent_inbox_items WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000ebbbb';
DELETE FROM email_messages WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000ebbbb';
DELETE FROM mailbox_accounts WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000ebbbb';
COMMIT;

\echo 'DONE.'
