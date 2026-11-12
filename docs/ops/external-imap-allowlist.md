# External IMAP allowlist (operator)

The external IMAP connector is read only in phase 1. A signed-in person connects
an existing mailbox over implicit TLS on port 993, browses INBOX, reads messages,
downloads attachments, and marks messages read or unread. Mail stays at the
provider. The connector is off for every workspace until an operator turns it on,
and it is turned on per workspace through an allowlist. This page covers the
settings, what each workspace sees on and off the list, how Disconnect behaves
today, and rollback. Setting names only; never commit values.

All placeholders below are fictional: `workspace-one`, `workspace-two`,
`imap.example.com`, `reader@example.com`.

## Settings

Three environment variables gate the connector. All are read from the backend
process environment on every request, so a change takes effect on the next
restart or redeploy.

| Name | Role | Default |
| --- | --- | --- |
| `EXTERNAL_IMAP_ENABLED` | Global switch for the read-only connector. Must be exactly `true`. | off (any other value) |
| `EXTERNAL_IMAP_WORKSPACE_IDS` | Per-workspace allowlist. Comma-separated workspace IDs. | empty (nobody) |
| `EXTERNAL_IMAP_SEND_ENABLED` | Phase 2 send switch, on top of the read gate. Must be exactly `true`. | off (any other value) |

Read gate: a workspace is enabled only when `EXTERNAL_IMAP_ENABLED` is exactly
`true` AND its ID is present in `EXTERNAL_IMAP_WORKSPACE_IDS`
(`backend/src/external-imap/imap-connection.ts:14-15`). The send gate adds the
third flag on top of the read gate
(`backend/src/external-imap/smtp-connection.ts:22-23`). Any value other than the
exact string `true` (including `1`, `TRUE`, or empty) counts as off.

## Allowlist format

`EXTERNAL_IMAP_WORKSPACE_IDS` is a comma-separated list of internal workspace
IDs. The value is split on commas, each entry is trimmed, and empty entries are
dropped (`backend/src/external-imap/imap-connection.ts:6-12`). Matching rules,
covered by `backend/src/external-imap/external-imap-gate.spec.ts:17-39`:

- IDs match exactly and are case sensitive. `WORKSPACE-ONE` does not match
  `workspace-one`.
- Surrounding whitespace and blank entries are ignored, so
  ` workspace-two, , workspace-one, workspace-one ` enables `workspace-one`.
- A prefix is not a match. `workspace-one-extra` does not enable `workspace-one`.
- `*` is not a wildcard. It enables nothing.
- An empty or unset allowlist enables no workspace. When the global flag is
  `true` but the allowlist is empty, the backend logs one warning at startup
  (`backend/src/external-imap/imap-connection.ts:92-98`).

The ID is the internal workspace ID, not a slug or display name. A wrong ID
enables nothing.

## Add a workspace

Append the workspace ID to `EXTERNAL_IMAP_WORKSPACE_IDS` (comma separated), keep
`EXTERNAL_IMAP_ENABLED=true`, then restart or redeploy the backend so the new
environment is loaded. For a single pilot, set the allowlist to that one ID. To
also allow sending from that workspace, set `EXTERNAL_IMAP_SEND_ENABLED=true`;
see `docs/operations/external-mailbox-send.md`.

## What a workspace OFF the list sees

A workspace not in the allowlist (or any workspace while the global flag is off)
is treated as if the connector does not exist. This is asserted end to end in
`backend/src/external-imap/external-imap-allowlist.spec.ts:103-134`:

- `GET /api/v1/workspaces/:workspaceId/external-imap/capabilities` returns
  `{ "enabled": false }` (`backend/src/external-imap/external-imap.controller.ts:48-51`).
- The "Connect another provider (IMAP)" control is hidden in the mail UI, which
  renders nothing when capabilities report disabled
  (`frontend/components/mail/ExternalImapConnect.tsx:49-54,88`).
- `POST .../external-imap/test` and `POST .../external-imap/connect` throw
  `NotFoundException` (HTTP 404) before any credential is used
  (`backend/src/external-imap/imap-connection.ts:17-19`,
  `backend/src/external-imap/external-imap.controller.ts:53-57`,
  `backend/src/external-imap/external-imap.accounts.ts:26,100`).
- A mailbox already stored as `external_imap` lists an empty INBOX with status
  `engine_not_configured` and never opens a connection
  (`backend/src/external-imap/external-imap.provider.ts:59-67,99-100`).
- No socket is opened. The gate runs before the client is created in every path
  (`backend/src/external-imap/imap-connection.ts:110,161`), and the spec asserts
  zero server connections and no DB write for an off-list workspace
  (`backend/src/external-imap/external-imap-allowlist.spec.ts:129-133`).
- There is no fallback to another provider. External IMAP mailboxes stay routed
  to the IMAP provider, which refuses while disabled
  (`backend/src/external-imap/external-imap.provider.ts:47-49`,
  `backend/src/mail-provider/routing-mail-provider.ts:16-20`).

## What an allowlisted workspace can do

With the global flag on and the workspace ID in the allowlist, a signed-in human
member can (`backend/src/external-imap/external-imap-allowlist.spec.ts:136-171`):

- Test credentials with `POST .../external-imap/test` and connect with
  `POST .../external-imap/connect`
  (`backend/src/external-imap/external-imap.controller.ts:59-79`). Connect stores
  the mailbox and an encrypted password, and returns only a status and mailbox ID
  (`backend/src/external-imap/external-imap.accounts.ts:21-97`).
- Browse INBOX, open threads, read inbox counts, mark threads read or unread, and
  download attachments through the mail provider
  (`backend/src/external-imap/external-imap.provider.ts:87-291`).

Connect requires mailbox encryption to be configured first, otherwise it returns
503 (`backend/src/external-imap/external-imap.accounts.ts:27-28`). Connections are
forced to port 993 with TLS; any other port or security mode is refused
(`backend/src/external-imap/imap-connection.ts:111-113`). Sending is not part of
this gate; it needs `EXTERNAL_IMAP_SEND_ENABLED=true` as well
(`backend/src/external-imap/external-imap.provider.ts:303`).

## How Disconnect behaves today

There is no in-app Disconnect for an external IMAP mailbox. The disconnect
endpoint only accepts `gmail` or `microsoft`; any other provider value is
rejected with 400 before anything changes
(`backend/src/connected-accounts/connected-accounts.controller.ts:117-133,305-308`,
`backend/src/connected-accounts/connected-accounts.types.ts:1`). The provider
union is only `gmail | microsoft`, so the mailbox-deactivate step never matches
an `external_imap` row
(`backend/src/connected-accounts/connected-accounts.service.ts:172-234,1827-1875`).

The effective off switch is the allowlist, not a disconnect action:

- Remove the workspace ID from `EXTERNAL_IMAP_WORKSPACE_IDS` (or turn the global
  flag off) and restart. The mailbox row stays `active` and its encrypted
  password stays stored, but it can no longer be read or sent through: the
  credential lookup throws `NotFoundException` for a disabled workspace
  (`backend/src/external-imap/external-imap.accounts.ts:114`).
- To cut provider access immediately, independent of this app, revoke that
  mailbox's app password at the provider.

## Roll back

Set `EXTERNAL_IMAP_ENABLED` to any value other than exactly `true` (for example
`false`), or clear `EXTERNAL_IMAP_WORKSPACE_IDS`, then restart or redeploy the
backend. After that, capabilities report `enabled:false`, test and connect return
404, reads return `engine_not_configured`, and no IMAP or SMTP connection is
opened (`backend/src/external-imap/external-imap-allowlist.spec.ts:173-189`).
To stop one customer while leaving others on, remove only that workspace ID from
the allowlist. Already-stored `external_imap_accounts` rows remain but are
unreadable while the workspace is off the list.

## Related

- `docs/operations/external-mailbox-send.md`: the phase 2 send flag
  `EXTERNAL_IMAP_SEND_ENABLED` and SMTP password handling.
- `docs/connect-other-imap.md`: the full connect flow, credentials, and test
  results from the user side.
