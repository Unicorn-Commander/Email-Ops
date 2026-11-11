# External IMAP allowlist (operator)

Phase 1 of the external IMAP connector is read only: a signed-in person connects
an existing mailbox over implicit TLS on port 993, browses INBOX, reads messages,
downloads attachments, and marks messages read or unread. Mail stays at the
provider. This page covers the two settings that turn the connector on for a
workspace and how to turn it back off. Setting names only; never commit values.

## Settings

Two environment variables gate the connector. Both are read from the backend
process environment on every request
(`backend/src/external-imap/imap-connection.ts:6-15`).

| Name | Role | Default |
| --- | --- | --- |
| `EXTERNAL_IMAP_ENABLED` | Global switch for the read-only external IMAP connector (phase 1). Must be exactly `true`. | false (any other value) |
| `EXTERNAL_IMAP_WORKSPACE_IDS` | Per-workspace allowlist. Comma-separated workspace IDs. | empty (nobody) |

A workspace is enabled only when `EXTERNAL_IMAP_ENABLED` is exactly `true` AND
its ID is present in `EXTERNAL_IMAP_WORKSPACE_IDS`
(`backend/src/external-imap/imap-connection.ts:14-15`). IDs match exactly;
surrounding whitespace and empty entries are ignored. An empty allowlist enables
no workspace and logs one warning at startup when the global flag is `true`
(`backend/src/external-imap/imap-connection.ts:92-98`).

## Add a workspace

Append the workspace ID to `EXTERNAL_IMAP_WORKSPACE_IDS` (comma separated), keep
`EXTERNAL_IMAP_ENABLED=true`, then redeploy or restart the backend so the new
environment is loaded. For a single pilot, set the allowlist to that one ID.

## Remove a workspace

Delete that ID from `EXTERNAL_IMAP_WORKSPACE_IDS` and redeploy or restart. The
global flag can stay on for the remaining workspaces.

## What a non-allowlisted workspace sees

- `GET /api/v1/workspaces/:workspaceId/external-imap/capabilities` returns
  `{ "enabled": false }`
  (`backend/src/external-imap/external-imap.controller.ts:48-51`).
- The "Connect another provider (IMAP)" control is hidden in the mail UI
  (`frontend/components/mail/ExternalImapConnect.tsx:49-51,88`).
- `POST .../external-imap/test` and `POST .../external-imap/connect` return 404
  (`backend/src/external-imap/imap-connection.ts:17-19`,
  `backend/src/external-imap/external-imap.controller.ts:53-57`).
- A mailbox already registered as `external_imap` lists an empty INBOX with
  status `engine_not_configured` and never opens a connection
  (`backend/src/external-imap/external-imap.provider.ts:99-100`).
- There is no fallback to another provider. External IMAP mailboxes stay on the
  IMAP provider, which refuses while disabled
  (`backend/src/mail-provider/routing-mail-provider.ts:16-21`).

## Roll back (flag off)

Set `EXTERNAL_IMAP_ENABLED` to any value other than exactly `true` (for example
`false`), or clear `EXTERNAL_IMAP_WORKSPACE_IDS`, then redeploy or restart the
backend. After that, capabilities report `enabled:false`, connect and test
endpoints return 404, reads return `engine_not_configured`, and no IMAP or SMTP
connection is opened. Rows already stored in `external_imap_accounts` remain but
cannot be read or sent through. To stop one customer at once, also revoke that
mailbox's app password at the provider.

## Related

- `docs/connect-other-imap.md` covers the full connect flow, the phase-2 SMTP
  send flag `EXTERNAL_IMAP_SEND_ENABLED`, credentials, and test results.
