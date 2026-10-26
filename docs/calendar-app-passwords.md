# Calendar per-device app keys

## As-built decision

Davis is configured with `AUTH_METHOD=IMAP` against James. A normal Davis login
therefore uses the James mailbox password. Davis native app keys provide the
per-device primitive we need: the CalDAV username is
`<mailbox-login>*<app-id>` and the generated secret is the password. Each key
has its own label, scope, expiry, last-use record, and immediate revocation.

Email-Ops never falls back to a signed-in user's password, the local user
password hash, `MailboxAccount.secretRef`, or the mailbox-password reset
endpoint. The production `CalendarCredentialsPort` binding is selected only
when both `CALENDAR_BRIDGE_URL` and `CALENDAR_BRIDGE_TOKEN` are configured;
otherwise it remains the existing fail-closed `UnavailableCalendarCredentials`.

## Private Davis bridge

`infrastructure/calendar/davis/bridge/` is a dependency-free PHP service
mounted into a sidecar made from the exact same pinned Davis image as the
CalDAV service. It calls Davis's native console commands with `proc_open` and
an argv array, with a bounded timeout and strict output parsing. The bridge is
published only on the mail host's tailnet address and is not attached to the
public calendar proxy.

All routes other than health require `Authorization: Bearer <token>`. Davis
stores only `BRIDGE_TOKEN_SHA256`; the bridge compares the SHA-256 digest in
constant time and can additionally enforce `BRIDGE_ALLOWED_SOURCES`. Audit
lines have the form `BRIDGE_AUDIT {json}` and contain only action, mailbox
login, app id, purpose, caller IP, and result. They never contain the raw
token, an Authorization header, or a secret.

The implemented contract is:

- `GET /v1/health` returns `{ "status": "ok" }` and does not expose secrets.
- `POST /v1/keys` accepts `{login, label, purpose, ttl_seconds}`. Login must
  be an email on `BRIDGE_ALLOWED_DOMAINS` and cannot be `ADMIN_LOGIN`. The
  bridge always invokes Davis with one `-u <login>` and never `--all-users`.
  Davis receives the name `email-ops:<purpose>:<label>`.
- Device keys default to 365 days and are capped at 400 days. Backend keys
  default to and are capped at 24 hours. Labels are printable ASCII and at
  most 64 characters. The response contains `app_id`, `secret`, `username`,
  and `expires_at`; the secret is held only in the in-memory idempotency cache
  for ten minutes and is never written to disk.
- If Davis does not know the login, the bridge returns a clear 409 unless
  `BRIDGE_AUTOCREATE_USERS=true`. When autocreation is enabled, it boots the
  Davis kernel and calls the same `Utils::createPasswordlessUserWithDefaultObjects`
  helper used by Davis's `IMAPAuth` path, then retries the native command.
- `GET /v1/keys?login=<email>` runs `davis:app-key:list`, strictly parses the
  table, and returns only `email-ops:` keys scoped to that login. Secrets are
  never listed.
- `DELETE /v1/keys/<app-id>` first proves the key name starts with
  `email-ops:`, runs Davis revoke, and re-lists to confirm the revoked status.
  Repeating a revoke is safe; a human-created Davis key is never touched.
- `Idempotency-Key` is required on create. A matching retry within ten minutes
  returns the original result without creating another Davis key; reusing the
  key for different request data is a 409.

The fake `bin/console` under the bridge tests emits the Davis 5.6.2 formats
from `davis-src/`. Its definition-list output includes Davis's literal
`<login>` Basic-username placeholder; the bridge resolves that to the concrete
username returned to Email-Ops.

## Email-Ops backend

`BridgeCalendarCredentials.resolve()` requests a `purpose=backend` key for the
mailbox's Davis login, caches the usable username and secret in process memory
until five minutes before Davis expiry, and returns `null` on bridge failure so
the calendar remains fail-closed. Cached bridge app ids are revoked best-effort
on graceful shutdown; Davis's expiry remains the backstop.

The additive Prisma model is `CalendarDeviceKey` (`calendar_device_keys`) with
`workspaceId`, `mailboxId`, `label`, `davisAppId`, `createdById`, `createdAt`,
`expiresAt`, and `revokedAt`. It stores no plaintext secret, no secret hash,
and no reversible credential. Davis is the authority. The migration grants
the normal application roles and enables/forces the same workspace RLS policy
used by the other tenant tables; `prisma/rls-acceptance.sql` includes
cross-workspace read, insert, update, and cleanup checks.

The workspace-scoped REST routes are exposed under the existing API prefix:

- `POST /workspaces/:workspaceId/calendar/devices` accepts `{mailboxId,label}`
  and returns the CalDAV server URL, concrete username, and secret exactly
  once, alongside non-secret metadata.
- `GET /workspaces/:workspaceId/calendar/devices?mailboxId=...` returns
  labels, app ids, timestamps, and status only.
- `DELETE /workspaces/:workspaceId/calendar/devices/:id` revokes Davis first
  and marks the row revoked only after confirmation. A failed confirmation
  leaves the row visible and returns an error so it can be retried.

All three routes use the Phase-2 mailbox visibility resolver and human-owner
fence. PAT and federation/MCP identities are rejected, and the routes use the
short and long throttlers. Bridge and backend exceptions are generic; no
secret, token, Authorization header, or bridge response body is logged or
returned.

## Browser behavior

The `/calendar` Devices panel lets a human choose a visible Davis-backed
mailbox, enter a printable device label, list existing metadata, and revoke a
key. After creation, a dialog displays the server URL, username, one-time
secret, and short iPhone and DAVx5 setup steps based on
`docs/calendar-phone-guide.md`. The UI never puts the secret in localStorage,
sessionStorage, cookies, or the device-list state. Closing the dialog clears
the in-memory secret; it cannot be retrieved through Email-Ops afterward.

## Rollout checklist for the orchestrator

- [ ] Review the pinned Davis image, bridge source, compose service, and
      tailnet bind address. Keep `davis-bridge` off the public proxy and set
      `BRIDGE_ALLOWED_SOURCES` to the Email-Ops tailnet source.
- [ ] Mint one high-entropy bridge token in the orchestrator. Store the raw
      token in the approved vault, supply only its SHA-256 digest as
      `BRIDGE_TOKEN_SHA256` to the Davis env, and inject the raw value into
      Email-Ops as `CALENDAR_BRIDGE_TOKEN`. This lane never creates or records
      a real deployment secret.
- [ ] Set `BRIDGE_ALLOWED_DOMAINS`, `BRIDGE_BIND_ADDRESS`, and the private
      bridge URL. Keep `BRIDGE_AUTOCREATE_USERS=false` for the first rollout;
      enable it only if the disposable-mailbox test has explicitly approved
      Davis's passwordless bootstrap path.
- [ ] Add the Email-Ops environment values `CALENDAR_BRIDGE_URL`,
      `CALENDAR_BRIDGE_TOKEN`, and `CALENDAR_SERVER_URL` through the normal
      vault/env injection path. Confirm that an environment missing either
      bridge value still fails closed.
- [ ] Deploy the additive Prisma migration for `calendar_device_keys` with
      the normal migration process, then run the RLS acceptance SQL using the
      approved RLS verification connection. Do not hand-edit production rows.
- [ ] From the allowed tailnet source, check `GET /v1/health` and then use a
      disposable test mailbox on an allowed deployment domain to create one
      device key through Email-Ops. Confirm the one-time response includes the
      server URL, username, and secret and that no secret appears in
      application, bridge, proxy, or database logs.
- [ ] Run a wire-level smoke test with the returned credentials: issue a
      CalDAV `PROPFIND` against the disposable mailbox and confirm it succeeds
      (normally HTTP 207). Revoke the device from Email-Ops, confirm the
      response says Davis confirmed it, then repeat the same `PROPFIND` and
      confirm authentication fails (normally HTTP 401/403).
- [ ] Confirm the revoked row remains visible with revoked status, a failed
      bridge confirmation remains visible as an error, a human-owned mailbox
      rejects a different member, and PAT/federation identities cannot reach
      any device route.
- [ ] Only after the above evidence is attached should the orchestrator approve
      the production enablement of the bridge-backed credential provider.

Until this checklist is complete, the existing mail app-password reset remains
a mailbox-wide password reset. It is not a per-device calendar credential.
