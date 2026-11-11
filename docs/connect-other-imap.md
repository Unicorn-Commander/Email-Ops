# Connect another provider with IMAP

Phase 1 lets a signed-in person connect an existing mailbox, browse INBOX threads,
read text/HTML messages, download attachments, and mark messages read or unread.
Mail remains at the provider. Phase 2 adds optional SMTP through the existing
human compose API and agent-inbox human approval flow. The phase-1 frontend
composer remains disabled in this backend-only change and still says:
“Sending from this mailbox is not available yet.”

## Availability

`EXTERNAL_IMAP_ENABLED` defaults to false. Availability requires the exact value
`true` AND the workspace ID in `EXTERNAL_IMAP_WORKSPACE_IDS`, a comma-separated
allowlist that defaults to empty. For a single pilot, set the allowlist to that
workspace ID. Whitespace around IDs and empty entries are ignored; IDs match
exactly. An empty allowlist enables nobody and logs one warning at startup when
the global flag is true. No separate frontend build flag is required.
For disabled or unlisted workspaces, the empty-state Connect screen is unchanged,
connection endpoints return 404, and IMAP reads and writes never connect. Previously registered IMAP rows remain in
the registry but cannot be read or sent through another provider as a fallback.

`EXTERNAL_IMAP_SEND_ENABLED` also defaults to false. Both flags must be exactly
`true`, and the workspace must be listed in `EXTERNAL_IMAP_WORKSPACE_IDS`, for
SMTP configuration, AUTH testing, or sending. For the operator runbook on
enabling sending for one workspace and rolling it back, see
[Send operator guide: external IMAP mailboxes](operations/external-mailbox-send.md).
The gate is checked again when a
human approves a draft and before the SMTP connection opens. Removing a workspace
from the allowlist prevents previously staged drafts from sending; they remain
pending for a later human approval. With the send flag off,
capabilities and existing IMAP-only requests retain their phase-1 shapes, SMTP
settings cannot be changed, and sends return the existing unavailable result.
There is no fallback to another provider.

The deployment owner must apply migrations `20261110193000_external_imap` and
`20261110210000_external_imap_smtp` using `prisma migrate deploy`, and
configure the existing `CONNECTED_ACCOUNT_ENC_KEY` before enabling the pilot.
That key is a base64-encoded 32-byte AES key. Preserve it through restarts and
backups; changing it without re-encryption makes existing credentials unreadable.
Do not place app passwords or the encryption key in tickets, logs, or source.

## Zoho Mail example for the Bureau pilot

Use the customer's own Zoho mailbox, represented here by `reader@example.com`.

1. In Zoho Mail, open Settings, Mail Accounts, and the primary account. Enable
   **IMAP Access** and save. Confirm the plan and administrator policy permit
   IMAP. See [Zoho's IMAP instructions](https://www.zoho.com/mail/help/imap-access.html).
2. In the regional Zoho Accounts site, open Security, App passwords, Generate New
   Password. Name it “Email-Ops” and use the generated application-specific
   password, without spaces. Keep MFA enabled. See
   [Zoho's app-password instructions](https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html).
3. Copy the incoming server from **Server Configuration Details** in that
   account. Zoho documents `imap.zoho.com.au` for Australia in its
   [regional hostname table](https://www.zoho.com/mail/help/adminconsole/autodiscovery-settings.html).
   Paid organization accounts use the `imappro` family in Zoho's general IMAP
   guide. Use `imappro.zoho.com.au` only if the account's own configuration shows
   it. Do not infer the hostname from the customer's domain or automatically
   substitute regions; the account-specific settings are authoritative.
4. In Email-Ops, choose the customer's workspace and open Mail. On **No mailboxes
   yet**, choose **Connect another provider (IMAP)**. Enter:

   | Field | Example |
   | --- | --- |
   | Mailbox email address | `reader@example.com` |
   | IMAP hostname | `imap.zoho.com.au`, or the account-provided `imappro.zoho.com.au` |
   | Username | `reader@example.com` (full Zoho mailbox address) |
   | App password | The dedicated app password generated above |
   | Port | `993`, fixed, implicit TLS |

5. Choose **Test connection**. Success means LOGIN and SELECT INBOX both worked.
   Choose **Connect mailbox** to re-test and save. The mailbox list refreshes
   automatically. The account belongs to the current person and is not made the
   default outbound identity.

The empty-state form is the phase-1 entry point. A signed-in owner can also
reconnect the same workspace/address using the connect endpoint to replace a
revoked app password. The form does not yet provide account management when the
workspace already has mailboxes. To stop access immediately, revoke the dedicated
app password at Zoho; disabling the Email-Ops flag stops every IMAP connection.

## Phase 2: Zoho SMTP through human approval

Use the outgoing hostname shown in the customer's **Server Configuration
Details**. For Australian accounts, this is `smtppro.zoho.com.au` for paid
organizations or `smtp.zoho.com.au` for personal/free accounts, as appropriate
for that account. Confirm the account's own regional settings before saving.
Zoho documents the account types, ports, authentication, and the authoritative
settings screen in its [SMTP configuration guide](https://www.zoho.com/mail/help/zoho-smtp.html).

After both flags are enabled and the workspace is allowlisted, a signed-in owner can use the existing `POST test`
and `POST connect` endpoints with the usual IMAP fields plus an optional nested
`smtp` object:

| SMTP field | Value |
| --- | --- |
| `host` | Account-provided `smtppro.zoho.com.au` or `smtp.zoho.com.au` |
| `port` | `465` for implicit TLS, or `587` for required STARTTLS |
| `username` | Optional; defaults to the IMAP username |
| `password` | Optional; reuses the encrypted IMAP app password unless supplied separately |

Port determines transport security; no plaintext option exists. STARTTLS must
be advertised and the verified upgrade must complete before AUTH. Both modes
require TLS 1.2 or newer and certificate verification. The exact socket address
uses the same public IPv4 DNS guard as IMAP. SMTP has a 20-second total deadline,
64 KiB maximum reply, and no protocol logging or connection pooling.

Test and connect perform IMAP LOGIN/SELECT and SMTP AUTH, without MAIL, RCPT,
or DATA. Both return the existing typed status shape. A failed SMTP test saves
nothing. Separate SMTP passwords are AES-256-GCM encrypted beside the IMAP
settings; omitted SMTP credentials inherit the current IMAP credentials.
Reconnect without an `smtp` object preserves existing SMTP settings. Reconnect
with `smtp` but without username/password resets those fields to inheritance.
PAT callers cannot test or change credentials, including SMTP settings.

Agent compose requests are staged in agent-inbox even when an autonomy policy
would otherwise allow sending. Human approval uses the existing mailbox-owner
checks. Agent approvals cannot send through SMTP. The existing human compose
API (`POST /api/v1/workspaces/:workspaceId/mail/:mailboxId/compose`) supplies
an internal authorization marker for signed-in sessions; a request body cannot
supply that marker. No new send endpoint, watcher, or background sender is added.

Replies resolve the latest message in the phase-1 thread group and build
In-Reply-To/References from provider metadata. Unknown/stale thread IDs fail
before sending. From is always the mailbox address. MIME includes Date and a
new Message-ID, plain text/HTML, attachments, and all To/Cc/Bcc envelope
recipients; Bcc is absent from the message headers. This lane supports ASCII
mail addresses and a maximum encoded message size of 25 MiB.

After SMTP accepts the message, Email-Ops APPENDs the same MIME bytes with
\Seen to the account's SPECIAL-USE \Sent folder, falling back to `Sent`.
If APPEND fails, the provider result remains accepted with a sanitized Sent-copy
warning (the current compose response does not expose provider warnings);
Email-Ops does not resend automatically. A lost SMTP acknowledgement after DATA
can leave delivery uncertain; check the provider before manually retrying.
Zoho can also save SMTP mail automatically. Disable its **Save copy of sent
emails** setting if duplicate Sent copies appear, following the
[Zoho duplicate-copy guidance](https://www.zoho.com/mail/help/zoho-smtp.html).

## Test results

| Result | Meaning and next step |
| --- | --- |
| `ok` | IMAP authentication/INBOX selection and, when supplied, SMTP AUTH succeeded. |
| `auth_failed` | IMAP or SMTP authentication failed. Check username, app password, region, and provider access. |
| `tls_failed` | Check hostname/certificate and required SMTP STARTTLS support. IMAP still requires implicit TLS. |
| `unreachable` | DNS, connection, timeout, or INBOX selection failed. Retry after checking provider access. |

Results never contain the provider's error text. Certificate validation cannot
be disabled. Public DNS hostnames are required; IP literals and internal/private
destinations are refused, with DNS validation applied to the socket's address.
Phase 1 currently uses IPv4 DNS resolution.

## Scope and implementation

- Backend routes under `/api/v1/workspaces/:workspaceId/external-imap`:
  `GET capabilities`, `POST test`, `POST connect`. POST bodies contain `host`,
  `port`, `security: "tls"`, `username`, `password`, `email_address`, and optional
  `smtp` settings described above. Connection
  management requires a browser/session identity, workspace membership, and the
  feature flag; personal access tokens cannot register credentials. Tests and
  connects are rate limited. Responses are `{status}` or `{status, mailbox_id}`.
- `external_imap_accounts` stores host, port, username, and AES-256-GCM ciphertext
  using `connected-accounts/crypto.ts`, plus nullable SMTP fields under the same
  forced RLS policy and grants. The mailbox registry only exposes its
  normal public view. Credential reads include mailbox, workspace, owner, active
  state, and provider predicates. Reconnection cannot take another owner's row
  or replace an existing hosted/Gmail/Microsoft send identity.
- `RoutingMailProvider` preserves the Engine provider for Gmail/Microsoft and
  always claims `external_imap`, even when disabled. Sends require both flags,
  a currently allowlisted workspace,
  configured SMTP, and the internal human/approval authorization marker. There
  is no sovereign fallback. Provider-side draft mirroring, automated inbound
  rules, folder mutation, archive/trash/spam, and flagging remain unavailable.
- ImapFlow 2.x supports the backend's Node 20 runtime. Each request creates and
  closes its own TLS session, with a 5-second connection/greeting timeout,
  10-second inactivity timeout, 20-second total request deadline, and no IDLE.
  All IMAP and SMTP library/protocol logging is disabled. See the
  [ImapFlow API](https://imapflow.com/docs/api/imapflow-client/).
- Threads use connected Message-ID/References/In-Reply-To components, including
  missing ancestors. IDs and page tokens include UIDVALIDITY. Browsing scans
  INBOX metadata only; message bodies use PEEK, and attachment bytes are fetched
  only when requested. Only explicit seen/unseen changes issue STORE.
- Phase 1 is INBOX-only, with no search or historical import. Metadata scans are
  limited to 10,000 messages; larger inboxes return an unavailable result rather
  than a silently incomplete list. Each downloaded MIME part is limited to
  25 MiB. Attachment sizes are the provider's encoded-size estimates. Page tokens
  use a live offset within the current UIDVALIDITY, not an immutable snapshot;
  refresh after new arrivals if paging shifts. Thread IDs may change if the
  provider deletes ancestors and remaining messages no longer reference them.

## Local verification without network calls in tests

From `backend`, run:

```sh
npx prisma generate
npx tsc --noEmit -p tsconfig.json
npm run test:unit -- --runInBand --testPathPattern=external-imap
```

The protocol integration suite is intentionally in Jest's hermetic `unit`
project. It uses the real ImapFlow parser and an in-memory fake IMAP server with
fictional `example.com` identities, plus an in-memory SMTP server.
DNS/TCP/TLS functions are blocked in the protocol suite. It covers
encryption, ownership, typed failures, secret-free results/logs, list/read/seen,
on-demand attachment bytes, UIDVALIDITY, timeout cleanup, TLS-only settings,
flag-off behavior, SMTP STARTTLS refusal, SMTP AUTH failures, reply MIME,
Sent APPEND, human/approval routing, and refusal of unattended sends and other
mutations. The RLS integration suite also checks SMTP columns under the existing
workspace policy. It does not
replace a real certificate-handshake test or the CI PostgreSQL migration lane.

Frontend regression commands (same temporary runner as the Gmail/M365 banner):

```sh
cd frontend
npm ci --no-audit --no-fund
npm install --no-save --package-lock=false --no-audit --no-fund vitest@3.2.4
./node_modules/.bin/vitest run components/mail/ExternalImapConnect.test.mjs components/mail/ListBannerView.test.mjs components/mail/MailUnavailableView.test.mjs --maxWorkers=2
npm ci --no-audit --no-fund
npm run build
```

The additive migration was generated without a database using
`prisma migrate diff --from-schema-datamodel <previous-schema> --to-schema-datamodel prisma/schema.prisma --script`.
CI's PostgreSQL service must apply it with `prisma migrate deploy`. No live
mailbox, database, host, container, or credentials were used for local validation.
