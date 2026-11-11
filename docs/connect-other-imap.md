# Connect another provider with IMAP

Phase 1 lets a signed-in person connect an existing mailbox, browse INBOX threads,
read text/HTML messages, download attachments, and mark messages read or unread.
Mail remains at the provider. There is no SMTP configuration or sending lane.
The UI says: “Sending from this mailbox is not available yet.”

## Availability

`EXTERNAL_IMAP_ENABLED` defaults to false. Only the exact value `true` enables it
on the backend; no separate frontend build flag is required. When disabled, the
empty-state Connect screen is unchanged, connection endpoints return 404, and
IMAP reads and writes never connect. Previously registered IMAP rows remain in
the registry but cannot be read or sent through another provider as a fallback.

The deployment owner must apply migration `20261110193000_external_imap` and
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

## Test results

| Result | Meaning and next step |
| --- | --- |
| `ok` | Authentication and INBOX selection succeeded. |
| `auth_failed` | Check full username, app password, account region, and IMAP access. |
| `tls_failed` | Check hostname and certificate. Plaintext and STARTTLS are refused. |
| `unreachable` | DNS, connection, timeout, or INBOX selection failed. Retry after checking provider access. |

Results never contain the provider's error text. Certificate validation cannot
be disabled. Public DNS hostnames are required; IP literals and internal/private
destinations are refused, with DNS validation applied to the socket's address.
Phase 1 currently uses IPv4 DNS resolution.

## Read-only scope and implementation

- Backend routes under `/api/v1/workspaces/:workspaceId/external-imap`:
  `GET capabilities`, `POST test`, `POST connect`. POST bodies contain `host`,
  `port`, `security: "tls"`, `username`, `password`, and `email_address`. Connection
  management requires a browser/session identity, workspace membership, and the
  feature flag; personal access tokens cannot register credentials. Tests and
  connects are rate limited. Responses are `{status}` or `{status, mailbox_id}`.
- `external_imap_accounts` stores host, port, username, and AES-256-GCM ciphertext
  using `connected-accounts/crypto.ts`. The mailbox registry only exposes its
  normal public view. Credential reads include mailbox, workspace, owner, active
  state, and provider predicates. Reconnection cannot take another owner's row
  or replace an existing hosted/Gmail/Microsoft send identity.
- `RoutingMailProvider` preserves the Engine provider for Gmail/Microsoft and
  always claims `external_imap`, even when disabled. Every IMAP send returns
  `accepted:false`; there is no SMTP or sovereign fallback. Draft staging and
  approval retain the existing agent-inbox flow. Approved sends can use only
  existing supported send identities; approval does not enable an IMAP send.
  Provider-side draft mirroring, automated inbound rules, folder mutation,
  archive/trash/spam, and flagging are unavailable for IMAP in phase 1.
- ImapFlow 2.x supports the backend's Node 20 runtime. Each request creates and
  closes its own TLS session, with a 5-second connection/greeting timeout,
  10-second inactivity timeout, 20-second total request deadline, and no IDLE.
  All library/protocol logging is disabled. See the
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
fictional `example.com` identities. DNS/TCP/TLS functions are blocked. It covers
encryption, ownership, typed failures, secret-free results/logs, list/read/seen,
on-demand attachment bytes, UIDVALIDITY, timeout cleanup, TLS-only settings,
flag-off behavior, and refusal of sending and other mutations. It does not
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
