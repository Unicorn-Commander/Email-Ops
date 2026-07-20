-- ============================================================================
-- Email-Ops Phase 7 RLS acceptance proof (run AS email_ops_app)
-- ============================================================================
--
-- One-command runner from backend/:
--
--   PGPASSWORD="$EMAIL_OPS_APP_PASSWORD" psql \
--     "postgresql://email_ops_app@HOST:PORT/emailops?sslmode=disable" \
--     -v ON_ERROR_STOP=1 -f prisma/rls-acceptance.sql
--
-- This script is self-asserting. It exits non-zero on the first failed proof.

\echo 'Email-Ops RLS acceptance: role posture, all fenced tables, bespoke predicates'

DO $$
DECLARE
  bypass boolean;
  missing text;
BEGIN
  SELECT rolbypassrls INTO bypass FROM pg_roles WHERE rolname = current_user;
  IF current_user <> 'email_ops_app' THEN
    RAISE EXCEPTION 'must run as email_ops_app, got %', current_user;
  END IF;
  IF bypass THEN
    RAISE EXCEPTION 'email_ops_app must be NOBYPASSRLS';
  END IF;

  WITH fenced(relname) AS (
    VALUES
      ('mailbox_accounts'), ('email_messages'), ('agent_inbox_items'),
      ('email_engagement_events'), ('thread_dispositions'), ('sender_policies'),
      ('sms_accounts'), ('sms_messages'), ('agents'), ('agent_mailboxes'),
      ('agent_action_events'), ('provisioning_policies'),
      ('mailbox_provisioning_requests'), ('cleanup_batches'), ('spaces'),
      ('space_mailboxes'), ('space_agents'), ('ui_commands'),
      ('mail_contacts'), ('mail_signatures'), ('mail_vacation_settings'),
      -- Wave 7: the agent-send trust allowlist.
      ('trusted_correspondents')
  )
  SELECT string_agg(f.relname, ', ' ORDER BY f.relname) INTO missing
  FROM fenced f
  LEFT JOIN pg_class c ON c.relname = f.relname
  WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing ENABLE/FORCE RLS on: %', missing;
  END IF;
END $$;

DO $$
DECLARE
  tbl text;
  n bigint;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'mailbox_accounts', 'email_messages', 'agent_inbox_items',
      'email_engagement_events', 'thread_dispositions', 'sender_policies',
      'sms_accounts', 'sms_messages', 'agents', 'agent_mailboxes',
      'agent_action_events', 'provisioning_policies',
      'mailbox_provisioning_requests', 'cleanup_batches', 'spaces',
      'space_mailboxes', 'space_agents', 'ui_commands',
      'mail_contacts', 'mail_signatures', 'mail_vacation_settings',
      'trusted_correspondents' -- Wave 7
    ])
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', tbl) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'no-GUC read on % returned %, expected 0', tbl, n;
    END IF;
  END LOOP;
END $$;

-- Control rows are intentionally global/non-RLS; the app role is granted these.
INSERT INTO workspaces (id, slug, "displayName", "updatedAt")
VALUES
  ('0190a000-7e57-7000-8000-0000000eaaaa', 'phase7-rls-aaaa', 'Phase 7 RLS AAAA', now()),
  ('0190a000-7e57-7000-8000-0000000ebbbb', 'phase7-rls-bbbb', 'Phase 7 RLS BBBB', now())
ON CONFLICT (id) DO UPDATE SET "displayName" = EXCLUDED."displayName", "updatedAt" = now();

\echo 'Seeding deterministic tenant rows under each workspace GUC'

BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
SELECT set_config('app.uc_uid', 'uc-uid-alice', true);
DELETE FROM space_mailboxes WHERE "spaceId" = 'sp-aaaa';
DELETE FROM space_agents WHERE "spaceId" = 'sp-aaaa';
DELETE FROM email_engagement_events WHERE id = 'eng-aaaa';
DELETE FROM agent_inbox_items WHERE id = 'inbox-aaaa';
DELETE FROM cleanup_batches WHERE id = 'cleanup-aaaa';
DELETE FROM mailbox_provisioning_requests WHERE id = 'mpr-aaaa';
DELETE FROM provisioning_policies WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000eaaaa';
DELETE FROM agent_mailboxes WHERE id = 'agent-mbx-aaaa';
DELETE FROM agent_action_events WHERE id = 'agent-event-aaaa';
DELETE FROM spaces WHERE id = 'sp-aaaa';
DELETE FROM agents WHERE id = 'agent-aaaa';
DELETE FROM sms_messages WHERE id = 'sms-msg-aaaa';
DELETE FROM sms_accounts WHERE id = 'sms-acct-aaaa';
DELETE FROM sender_policies WHERE id = 'sender-aaaa';
DELETE FROM thread_dispositions WHERE id = 'td-aaaa';
DELETE FROM email_messages WHERE id = 'msg-aaaa';
DELETE FROM mailbox_accounts WHERE id = 'mbx-aaaa';
DELETE FROM ui_commands WHERE id IN ('ui-aaaa-alice', 'ui-aaaa-bob');

INSERT INTO mailbox_accounts (id, "workspaceId", "emailAddress", "isDefault", "postmarkLane", active, "createdAt", "updatedAt")
VALUES ('mbx-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'desk-aaaa@example.test', true, true, true, now(), now());
INSERT INTO email_messages (id, "workspaceId", "mailboxAccountId", "contactId", "threadId", "externalSource", "externalRef", mode, status, direction, "toAddress", subject, "providerMessageId", "createdAt", "updatedAt")
VALUES ('msg-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'mbx-aaaa', 'contact-aaaa', 'thread-aaaa', 'phase7', 'email-aaaa', 'SEND', 'SENT', 'SENT', 'lead-aaaa@example.test', 'AAAA', 'pmid-aaaa', now(), now());
INSERT INTO agent_inbox_items (id, "workspaceId", "messageId", kind, state, "draftedBy", summary, "createdAt", "updatedAt")
VALUES ('inbox-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'msg-aaaa', 'EMAIL', 'PENDING', 'agent-aaaa', 'AAAA', now(), now());
INSERT INTO email_engagement_events (id, "workspaceId", "emailMessageId", provider, "providerEventId", "recordType", "normalizedKind", "occurredAt", "createdAt", "updatedAt")
VALUES ('eng-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'msg-aaaa', 'postmark', 'evt-aaaa', 'Open', 'OPENED', now(), now(), now());
INSERT INTO thread_dispositions (id, "workspaceId", "threadId", disposition, "createdAt", "updatedAt")
VALUES ('td-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'thread-aaaa', 'ARCHIVE', now(), now());
INSERT INTO sender_policies (id, "workspaceId", scope, pattern, kind, "createdAt", "updatedAt")
VALUES ('sender-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'DOMAIN', 'aaaa.example.test', 'ALLOW', now(), now());
INSERT INTO sms_accounts (id, "workspaceId", "phoneNumber", "isDefault", active, "createdAt", "updatedAt")
VALUES ('sms-acct-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', '+1555000AAAA', true, true, now(), now());
INSERT INTO sms_messages (id, "workspaceId", "smsAccountId", "externalSource", "externalRef", mode, status, direction, "fromPhoneNumber", "toPhoneNumber", body, "providerMessageId", "createdAt", "updatedAt")
VALUES ('sms-msg-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'sms-acct-aaaa', 'phase7', 'sms-aaaa', 'SEND', 'SENT', 'SENT', '+1555000AAAA', '+15551110000', 'AAAA', 'SMaaaa', now(), now());
INSERT INTO agents (id, "workspaceId", key, "displayName", "mailboxAccountId", "createdAt", "updatedAt")
VALUES ('agent-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'agent-aaaa', 'Agent AAAA', 'mbx-aaaa', now(), now());
INSERT INTO agent_mailboxes (id, "workspaceId", "agentId", "mailboxAccountId", access, "isPrimary", "createdAt", "updatedAt")
VALUES ('agent-mbx-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'agent-aaaa', 'mbx-aaaa', 'BOTH', true, now(), now());
INSERT INTO agent_action_events (id, "workspaceId", kind, "agentKey", "messageId", "actorUcUid", detail, "createdAt")
VALUES ('agent-event-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'STAGED_FOR_APPROVAL', 'agent-aaaa', 'msg-aaaa', 'uc-uid-alice', 'AAAA', now());
INSERT INTO provisioning_policies ("workspaceId", "updatedByUcUid", "createdAt", "updatedAt")
VALUES ('0190a000-7e57-7000-8000-0000000eaaaa', 'uc-uid-alice', now(), now());
INSERT INTO mailbox_provisioning_requests (id, "workspaceId", kind, action, state, payload, summary, "createdAt", "updatedAt")
VALUES ('mpr-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'HUMAN_MAILBOX', 'CREATE', 'PENDING', '{"emailAddress":"new-aaaa@example.test"}', 'AAAA', now(), now());
INSERT INTO cleanup_batches (id, "workspaceId", provider, action, mode, state, plan, summary, "createdAt", "updatedAt")
VALUES ('cleanup-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'gmail', 'TRASH', 'trash', 'PENDING', '{"safe":[]}', 'AAAA', now(), now());
INSERT INTO spaces (id, "workspaceId", "ownerKey", visibility, name, "createdAt", "updatedAt")
VALUES ('sp-aaaa', '0190a000-7e57-7000-8000-0000000eaaaa', 'uc-uid-alice', 'PERSONAL', 'AAAA Space', now(), now());
INSERT INTO space_mailboxes ("spaceId", "mailboxAccountId") VALUES ('sp-aaaa', 'mbx-aaaa');
INSERT INTO space_agents ("spaceId", "agentId") VALUES ('sp-aaaa', 'agent-aaaa');
INSERT INTO ui_commands (id, "workspaceId", "ucUid", kind, payload, "createdAt")
VALUES ('ui-aaaa-alice', '0190a000-7e57-7000-8000-0000000eaaaa', 'uc-uid-alice', 'NOTIFY', '{"message":"AAAA"}', now());
COMMIT;

BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000ebbbb', true);
SELECT set_config('app.uc_uid', 'uc-uid-bob', true);
DELETE FROM space_mailboxes WHERE "spaceId" = 'sp-bbbb';
DELETE FROM space_agents WHERE "spaceId" = 'sp-bbbb';
DELETE FROM email_engagement_events WHERE id = 'eng-bbbb';
DELETE FROM agent_inbox_items WHERE id = 'inbox-bbbb';
DELETE FROM cleanup_batches WHERE id = 'cleanup-bbbb';
DELETE FROM mailbox_provisioning_requests WHERE id = 'mpr-bbbb';
DELETE FROM provisioning_policies WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000ebbbb';
DELETE FROM agent_mailboxes WHERE id = 'agent-mbx-bbbb';
DELETE FROM agent_action_events WHERE id = 'agent-event-bbbb';
DELETE FROM spaces WHERE id = 'sp-bbbb';
DELETE FROM agents WHERE id = 'agent-bbbb';
DELETE FROM sms_messages WHERE id = 'sms-msg-bbbb';
DELETE FROM sms_accounts WHERE id = 'sms-acct-bbbb';
DELETE FROM sender_policies WHERE id = 'sender-bbbb';
DELETE FROM thread_dispositions WHERE id = 'td-bbbb';
DELETE FROM email_messages WHERE id = 'msg-bbbb';
DELETE FROM mailbox_accounts WHERE id = 'mbx-bbbb';
DELETE FROM ui_commands WHERE id = 'ui-bbbb-bob';

INSERT INTO mailbox_accounts (id, "workspaceId", "emailAddress", "isDefault", "postmarkLane", active, "createdAt", "updatedAt")
VALUES ('mbx-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'desk-bbbb@example.test', true, true, true, now(), now());
INSERT INTO email_messages (id, "workspaceId", "mailboxAccountId", "contactId", "threadId", "externalSource", "externalRef", mode, status, direction, "toAddress", subject, "providerMessageId", "createdAt", "updatedAt")
VALUES ('msg-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'mbx-bbbb', 'contact-bbbb', 'thread-bbbb', 'phase7', 'email-bbbb', 'SEND', 'SENT', 'SENT', 'lead-bbbb@example.test', 'BBBB', 'pmid-bbbb', now(), now());
INSERT INTO agent_inbox_items (id, "workspaceId", "messageId", kind, state, "draftedBy", summary, "createdAt", "updatedAt")
VALUES ('inbox-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'msg-bbbb', 'EMAIL', 'PENDING', 'agent-bbbb', 'BBBB', now(), now());
INSERT INTO email_engagement_events (id, "workspaceId", "emailMessageId", provider, "providerEventId", "recordType", "normalizedKind", "occurredAt", "createdAt", "updatedAt")
VALUES ('eng-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'msg-bbbb', 'postmark', 'evt-bbbb', 'Open', 'OPENED', now(), now(), now());
INSERT INTO thread_dispositions (id, "workspaceId", "threadId", disposition, "createdAt", "updatedAt")
VALUES ('td-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'thread-bbbb', 'ARCHIVE', now(), now());
INSERT INTO sender_policies (id, "workspaceId", scope, pattern, kind, "createdAt", "updatedAt")
VALUES ('sender-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'DOMAIN', 'bbbb.example.test', 'ALLOW', now(), now());
INSERT INTO sms_accounts (id, "workspaceId", "phoneNumber", "isDefault", active, "createdAt", "updatedAt")
VALUES ('sms-acct-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', '+1555000BBBB', true, true, now(), now());
INSERT INTO sms_messages (id, "workspaceId", "smsAccountId", "externalSource", "externalRef", mode, status, direction, "fromPhoneNumber", "toPhoneNumber", body, "providerMessageId", "createdAt", "updatedAt")
VALUES ('sms-msg-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'sms-acct-bbbb', 'phase7', 'sms-bbbb', 'SEND', 'SENT', 'SENT', '+1555000BBBB', '+15552220000', 'BBBB', 'SMbbbb', now(), now());
INSERT INTO agents (id, "workspaceId", key, "displayName", "mailboxAccountId", "createdAt", "updatedAt")
VALUES ('agent-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'agent-bbbb', 'Agent BBBB', 'mbx-bbbb', now(), now());
INSERT INTO agent_mailboxes (id, "workspaceId", "agentId", "mailboxAccountId", access, "isPrimary", "createdAt", "updatedAt")
VALUES ('agent-mbx-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'agent-bbbb', 'mbx-bbbb', 'BOTH', true, now(), now());
INSERT INTO agent_action_events (id, "workspaceId", kind, "agentKey", "messageId", "actorUcUid", detail, "createdAt")
VALUES ('agent-event-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'STAGED_FOR_APPROVAL', 'agent-bbbb', 'msg-bbbb', 'uc-uid-bob', 'BBBB', now());
INSERT INTO provisioning_policies ("workspaceId", "updatedByUcUid", "createdAt", "updatedAt")
VALUES ('0190a000-7e57-7000-8000-0000000ebbbb', 'uc-uid-bob', now(), now());
INSERT INTO mailbox_provisioning_requests (id, "workspaceId", kind, action, state, payload, summary, "createdAt", "updatedAt")
VALUES ('mpr-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'HUMAN_MAILBOX', 'CREATE', 'PENDING', '{"emailAddress":"new-bbbb@example.test"}', 'BBBB', now(), now());
INSERT INTO cleanup_batches (id, "workspaceId", provider, action, mode, state, plan, summary, "createdAt", "updatedAt")
VALUES ('cleanup-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'gmail', 'TRASH', 'trash', 'PENDING', '{"safe":[]}', 'BBBB', now(), now());
INSERT INTO spaces (id, "workspaceId", "ownerKey", visibility, name, "createdAt", "updatedAt")
VALUES ('sp-bbbb', '0190a000-7e57-7000-8000-0000000ebbbb', 'uc-uid-bob', 'PERSONAL', 'BBBB Space', now(), now());
INSERT INTO space_mailboxes ("spaceId", "mailboxAccountId") VALUES ('sp-bbbb', 'mbx-bbbb');
INSERT INTO space_agents ("spaceId", "agentId") VALUES ('sp-bbbb', 'agent-bbbb');
INSERT INTO ui_commands (id, "workspaceId", "ucUid", kind, payload, "createdAt")
VALUES ('ui-bbbb-bob', '0190a000-7e57-7000-8000-0000000ebbbb', 'uc-uid-bob', 'NOTIFY', '{"message":"BBBB"}', now());
COMMIT;

\echo 'Asserting cross-tenant invisibility, including space_* and ui_commands ucUid fence'

DO $$
DECLARE
  n bigint;
BEGIN
  PERFORM set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
  PERFORM set_config('app.uc_uid', 'uc-uid-alice', true);

  SELECT count(*) INTO n FROM mailbox_accounts WHERE id = 'mbx-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'mailbox_accounts leaked'; END IF;
  SELECT count(*) INTO n FROM email_messages WHERE id = 'msg-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'email_messages leaked'; END IF;
  SELECT count(*) INTO n FROM agent_inbox_items WHERE id = 'inbox-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'agent_inbox_items leaked'; END IF;
  SELECT count(*) INTO n FROM email_engagement_events WHERE id = 'eng-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'email_engagement_events leaked'; END IF;
  SELECT count(*) INTO n FROM thread_dispositions WHERE id = 'td-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'thread_dispositions leaked'; END IF;
  SELECT count(*) INTO n FROM sender_policies WHERE id = 'sender-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'sender_policies leaked'; END IF;
  SELECT count(*) INTO n FROM sms_accounts WHERE id = 'sms-acct-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'sms_accounts leaked'; END IF;
  SELECT count(*) INTO n FROM sms_messages WHERE id = 'sms-msg-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'sms_messages leaked'; END IF;
  SELECT count(*) INTO n FROM agents WHERE id = 'agent-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'agents leaked'; END IF;
  SELECT count(*) INTO n FROM agent_mailboxes WHERE id = 'agent-mbx-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'agent_mailboxes leaked'; END IF;
  SELECT count(*) INTO n FROM agent_action_events WHERE id = 'agent-event-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'agent_action_events leaked'; END IF;
  SELECT count(*) INTO n FROM provisioning_policies WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000ebbbb'; IF n <> 0 THEN RAISE EXCEPTION 'provisioning_policies leaked'; END IF;
  SELECT count(*) INTO n FROM mailbox_provisioning_requests WHERE id = 'mpr-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'mailbox_provisioning_requests leaked'; END IF;
  SELECT count(*) INTO n FROM cleanup_batches WHERE id = 'cleanup-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'cleanup_batches leaked'; END IF;
  SELECT count(*) INTO n FROM spaces WHERE id = 'sp-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'spaces leaked'; END IF;
  SELECT count(*) INTO n FROM space_mailboxes WHERE "spaceId" = 'sp-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'space_mailboxes leaked via foreign parent space'; END IF;
  SELECT count(*) INTO n FROM space_agents WHERE "spaceId" = 'sp-bbbb'; IF n <> 0 THEN RAISE EXCEPTION 'space_agents leaked via foreign parent space'; END IF;
  SELECT count(*) INTO n FROM ui_commands WHERE id = 'ui-bbbb-bob'; IF n <> 0 THEN RAISE EXCEPTION 'ui_commands leaked across workspace'; END IF;

  SELECT count(*) INTO n FROM ui_commands WHERE id = 'ui-aaaa-alice'; IF n <> 1 THEN RAISE EXCEPTION 'ui_commands owner row invisible'; END IF;
  PERFORM set_config('app.uc_uid', 'uc-uid-bob', true);
  SELECT count(*) INTO n FROM ui_commands WHERE id = 'ui-aaaa-alice'; IF n <> 0 THEN RAISE EXCEPTION 'ui_commands leaked to same-workspace different ucUid'; END IF;
END $$;

\echo 'Asserting WITH CHECK blocks cross-workspace and per-user writes'

DO $$
BEGIN
  PERFORM set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
  PERFORM set_config('app.uc_uid', 'uc-uid-alice', true);

  BEGIN
    INSERT INTO email_messages (id, "workspaceId", "externalSource", "externalRef", mode, status, direction, "createdAt", "updatedAt")
    VALUES ('msg-evil', '0190a000-7e57-7000-8000-0000000ebbbb', 'phase7', 'evil-email', 'SEND', 'QUEUED', 'SENT', now(), now());
    RAISE EXCEPTION 'cross-workspace email_messages insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation OR foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO space_mailboxes ("spaceId", "mailboxAccountId") VALUES ('sp-bbbb', 'mbx-aaaa');
    RAISE EXCEPTION 'foreign-space space_mailboxes insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation OR foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO space_agents ("spaceId", "agentId") VALUES ('sp-bbbb', 'agent-aaaa');
    RAISE EXCEPTION 'foreign-space space_agents insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation OR foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO ui_commands (id, "workspaceId", "ucUid", kind, payload, "createdAt")
    VALUES ('ui-aaaa-bob', '0190a000-7e57-7000-8000-0000000eaaaa', 'uc-uid-bob', 'NOTIFY', '{"message":"wrong user"}', now());
    RAISE EXCEPTION 'same-workspace different-ucUid ui_commands insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
END $$;

\echo 'Asserting cross-fence UPDATE/DELETE are no-ops'

DO $$
DECLARE
  changed integer;
BEGIN
  PERFORM set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
  PERFORM set_config('app.uc_uid', 'uc-uid-alice', true);

  UPDATE email_messages SET status = status WHERE id = 'msg-bbbb';
  GET DIAGNOSTICS changed = ROW_COUNT; IF changed <> 0 THEN RAISE EXCEPTION 'cross-fence UPDATE email_messages changed % rows', changed; END IF;
  DELETE FROM agent_inbox_items WHERE id = 'inbox-bbbb';
  GET DIAGNOSTICS changed = ROW_COUNT; IF changed <> 0 THEN RAISE EXCEPTION 'cross-fence DELETE agent_inbox_items changed % rows', changed; END IF;
  UPDATE space_mailboxes SET "mailboxAccountId" = "mailboxAccountId" WHERE "spaceId" = 'sp-bbbb';
  GET DIAGNOSTICS changed = ROW_COUNT; IF changed <> 0 THEN RAISE EXCEPTION 'cross-fence UPDATE space_mailboxes changed % rows', changed; END IF;
  DELETE FROM space_agents WHERE "spaceId" = 'sp-bbbb';
  GET DIAGNOSTICS changed = ROW_COUNT; IF changed <> 0 THEN RAISE EXCEPTION 'cross-fence DELETE space_agents changed % rows', changed; END IF;
  UPDATE ui_commands SET "consumedAt" = "consumedAt" WHERE id = 'ui-bbbb-bob';
  GET DIAGNOSTICS changed = ROW_COUNT; IF changed <> 0 THEN RAISE EXCEPTION 'cross-fence UPDATE ui_commands changed % rows', changed; END IF;
END $$;

\echo 'Cleaning deterministic Phase 7 rows'

BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000eaaaa', true);
SELECT set_config('app.uc_uid', 'uc-uid-alice', true);
DELETE FROM space_mailboxes WHERE "spaceId" = 'sp-aaaa';
DELETE FROM space_agents WHERE "spaceId" = 'sp-aaaa';
DELETE FROM email_engagement_events WHERE id = 'eng-aaaa';
DELETE FROM agent_inbox_items WHERE id = 'inbox-aaaa';
DELETE FROM cleanup_batches WHERE id = 'cleanup-aaaa';
DELETE FROM mailbox_provisioning_requests WHERE id = 'mpr-aaaa';
DELETE FROM provisioning_policies WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000eaaaa';
DELETE FROM agent_mailboxes WHERE id = 'agent-mbx-aaaa';
DELETE FROM agent_action_events WHERE id = 'agent-event-aaaa';
DELETE FROM spaces WHERE id = 'sp-aaaa';
DELETE FROM agents WHERE id = 'agent-aaaa';
DELETE FROM sms_messages WHERE id = 'sms-msg-aaaa';
DELETE FROM sms_accounts WHERE id = 'sms-acct-aaaa';
DELETE FROM sender_policies WHERE id = 'sender-aaaa';
DELETE FROM thread_dispositions WHERE id = 'td-aaaa';
DELETE FROM email_messages WHERE id = 'msg-aaaa';
DELETE FROM mailbox_accounts WHERE id = 'mbx-aaaa';
DELETE FROM ui_commands WHERE id IN ('ui-aaaa-alice', 'ui-aaaa-bob');
COMMIT;

BEGIN;
SELECT set_config('app.current_workspace', '0190a000-7e57-7000-8000-0000000ebbbb', true);
SELECT set_config('app.uc_uid', 'uc-uid-bob', true);
DELETE FROM space_mailboxes WHERE "spaceId" = 'sp-bbbb';
DELETE FROM space_agents WHERE "spaceId" = 'sp-bbbb';
DELETE FROM email_engagement_events WHERE id = 'eng-bbbb';
DELETE FROM agent_inbox_items WHERE id = 'inbox-bbbb';
DELETE FROM cleanup_batches WHERE id = 'cleanup-bbbb';
DELETE FROM mailbox_provisioning_requests WHERE id = 'mpr-bbbb';
DELETE FROM provisioning_policies WHERE "workspaceId" = '0190a000-7e57-7000-8000-0000000ebbbb';
DELETE FROM agent_mailboxes WHERE id = 'agent-mbx-bbbb';
DELETE FROM agent_action_events WHERE id = 'agent-event-bbbb';
DELETE FROM spaces WHERE id = 'sp-bbbb';
DELETE FROM agents WHERE id = 'agent-bbbb';
DELETE FROM sms_messages WHERE id = 'sms-msg-bbbb';
DELETE FROM sms_accounts WHERE id = 'sms-acct-bbbb';
DELETE FROM sender_policies WHERE id = 'sender-bbbb';
DELETE FROM thread_dispositions WHERE id = 'td-bbbb';
DELETE FROM email_messages WHERE id = 'msg-bbbb';
DELETE FROM mailbox_accounts WHERE id = 'mbx-bbbb';
DELETE FROM ui_commands WHERE id = 'ui-bbbb-bob';
COMMIT;

DELETE FROM workspaces WHERE id IN ('0190a000-7e57-7000-8000-0000000eaaaa', '0190a000-7e57-7000-8000-0000000ebbbb');

\echo 'RLS acceptance proof passed.'
