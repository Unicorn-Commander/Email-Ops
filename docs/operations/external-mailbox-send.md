# Send operator guide: external IMAP mailboxes

Operator guide for sending mail through a connected IMAP/SMTP mailbox (PR #83, tests #89).
This lane is off by default and is enabled per workspace. It does not change reading,
browsing, or other mailboxes.

## What the flags do

Two exact-value flags and one allow list control sending, all read by the backend at
request time:

- `EXTERNAL_IMAP_ENABLED` defaults to off. It must be exactly `true`.
- `EXTERNAL_IMAP_WORKSPACE_IDS` is the workspace allow list. A comma-separated list of
  workspace IDs that defaults to empty. Whitespace around IDs and empty entries are
  ignored; IDs match exactly.
- `EXTERNAL_IMAP_SEND_ENABLED` defaults to off. It must be exactly `true`.

Sending requires all three: both flags exactly `true` and the mailbox's workspace ID in
the allow list. Any other value (including `1`, `TRUE`, or an empty string) counts as
off. The allow list gates the whole IMAP connection, including reading; the send flag
adds the send gate on top.

The gate is checked twice per send: once when the send request starts and again before
the SMTP connection opens. A send that starts with the gate open can be refused at the
second check if the gate closes in the meantime.

## What the user sees when sending is not available

- Mail page: when the selected mailbox is an external IMAP mailbox, the compose button
  is hidden and the message "Sending from this mailbox is not available yet." is shown
  as a status line.
- IMAP connect form: the helper text "Read your INBOX and mark messages seen. Sending
  from this mailbox is not available yet." is shown while the form is open.
- Send API: a send attempt returns `accepted: false` with the reason
  "Sending from this mailbox is not available yet." Nothing is delivered, nothing is
  saved to the Sent folder, and no provider error text is returned.
- Connection test: when a `test` or `connect` request includes SMTP settings and the
  send gate is closed, the endpoint returns 404 without testing SMTP.

## Enable sending for one workspace

1. Confirm the prerequisites from the IMAP connection doc
   (`docs/connect-other-imap.md`): migrations `20261110193000_external_imap` and
   `20261110210000_external_imap_smtp` applied with `prisma migrate deploy`, and
   `CONNECTED_ACCOUNT_ENC_KEY` configured before any mailbox is connected.
2. In the backend environment, set `EXTERNAL_IMAP_ENABLED` to exactly `true`.
3. Set `EXTERNAL_IMAP_WORKSPACE_IDS` to the single workspace ID to enable.
4. Set `EXTERNAL_IMAP_SEND_ENABLED` to exactly `true`.
5. Restart or redeploy the backend so the process picks up the environment.
6. Ask the mailbox owner to connect the mailbox with SMTP settings, or reconnect an
   existing mailbox with an `smtp` object. The connection test performs IMAP login and
   SMTP AUTH only, without sending a message.

The workspace ID is the internal ID, not the slug. A wrong ID enables nothing.

## Roll back

- To stop sending only: remove `EXTERNAL_IMAP_SEND_ENABLED` (or set it to any value
  other than `true`) and restart the backend. Reading and IMAP-only use are unchanged.
- To stop the whole connection: remove the workspace ID from
  `EXTERNAL_IMAP_WORKSPACE_IDS` and restart the backend. This also stops reading and
  connection endpoints for that workspace.

Rollback takes effect for new send requests after the restart. Already-sent messages
cannot be recalled. Removing the workspace from the allow list prevents previously
staged agent drafts from sending; they remain pending for a later human approval.
Revoking the app password at the mail provider stops access immediately, without any
change on this side.

## SMTP password handling

The SMTP password is never logged and is never returned by any endpoint:

- Stored: AES-256-GCM encrypted with `CONNECTED_ACCOUNT_ENC_KEY`, in the
  `external_imap_accounts` row. The connect response returns only a status and a
  mailbox ID. The connect endpoint returns 404 when the send gate is closed, so SMTP
  settings cannot be saved that way.
- In transit: sent over the SMTP connection only during AUTH (PLAIN or LOGIN). STARTTLS
  on port 587 must complete before AUTH; port 465 uses implicit TLS. There is no
  plaintext option.
- On failure: provider results and error text are sanitized to typed statuses
  (`ok`, `auth_failed`, `tls_failed`, `unreachable`). The provider's own error text,
  which could contain the password, is never attached to an error or a log.
- In logs: all IMAP and SMTP protocol logging is disabled. The test suite
  (`backend/src/external-imap/smtp-send-gate.spec.ts`) asserts the fixture password
  never appears in any log call or in any refusal result.
