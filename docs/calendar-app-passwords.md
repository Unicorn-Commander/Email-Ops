# Calendar per-device app passwords

## Decision

Davis is configured with `AUTH_METHOD=IMAP` against James. A normal Davis login
therefore uses the James mailbox password. Davis also supports native app keys:
the client username is `<mailbox-login>*<app-id>` and the generated key secret is
the password. Native Davis app keys are the smallest safe per-device primitive;
changing James to accept a second class of mailbox passwords would create a
mailbox-wide credential, not a revocable device credential.

Email-Ops does not currently have a safe server-side resolver for a mailbox
password. `MailboxAccount.secretRef` is an indirect reference and is not a
credential source, while the existing mail provider paths use global engine or
brokered provider credentials. The calendar backend consequently uses an
explicit `CalendarCredentialsPort` and the production binding returns no
credential until the deployment bridge described below exists. It never falls
back to the signed-in user's password, the local user password hash, or the
existing mailbox-password reset endpoint.

## Proposed user flow

1. The signed-in user chooses a mailbox they are allowed to use and enters a
   device label such as “Personal phone”. The mailbox owner fence and workspace
   scope are checked before any remote operation.
2. A private your-mail-host bridge asks Davis to create one native app key for that
   mailbox and label. The bridge returns the app id and secret exactly once.
3. Email-Ops stores the device label, mailbox id, Davis app-id/reference, a
   salted verifier of the secret, created/revoked timestamps, and audit data.
   It does not store the plaintext secret. The phone receives the plaintext once
   over the authenticated HTTPS session and the UI cannot retrieve it later.
4. The phone uses the Davis server with username
   `<mailbox-email>*<app-id>` and the one-time secret. Future Email-Ops CalDAV
   calls use an ephemeral credential supplied by the bridge or a secret-manager
   reference; a salted hash alone is intentionally not treated as a usable
   CalDAV password.
5. Revoke first calls Davis and only marks the Email-Ops record revoked after a
   confirmed remote result. A failed or unknown remote revocation stays visible
   as an operational error and is retried by an operator, rather than reporting
   a false green state.

## Threat model and controls

The secret grants calendar/CardDAV access as one mailbox. The design protects
against a lost phone, a co-member naming another person's human mailbox,
workspace-ID confusion, database disclosure, log/telemetry leakage, browser
history or support-copy leakage, and replay after revocation.

- The bridge is private to your-mail-host, authenticated from Email-Ops with a
  narrowly scoped service identity, and allowlisted to Davis app-key operations.
- Every create/list/revoke request is workspace-scoped and passes the existing
  mailbox visibility plus human-owner fence. A shared mailbox remains a shared
  resource; a human mailbox remains private to its owner.
- Email-Ops stores only a memory-hard salted hash (Argon2id or scrypt with a
  per-record random salt) and non-secret metadata. Hashes are never returned by
  an API or placed in comments, logs, browser storage, analytics, or audit
  detail. The native Davis secret is held by the phone and, if backend access
  is needed, by the deployment secret manager/bridge—not by this repository's
  Prisma row.
- The plaintext is shown once, with copy/download disabled after the response
  is dismissed. Responses, reverse-proxy access logs, exception messages, and
  metrics must redact `Authorization`, app-key usernames, and secret fields.
- Names are metadata only and cannot grant access. Device labels are length
  limited and treated as untrusted text. List responses show status and last
  use, never a secret or a reversible credential reference.
- Davis revocation is the authoritative kill switch. Email-Ops revocation is
  idempotent, audited, rate-limited, and must not be accepted as complete when
  the bridge cannot prove Davis removed the key.
- Create/revoke endpoints require CSRF-safe authenticated browser calls (or a
  same-origin session), recent authentication for a high-value action, and
  replay protection on the bridge request. The bridge must not accept a raw
  mailbox email from the client as an authority claim.

## Why James app passwords are not the choice

James is the identity provider Davis consults through IMAP. A James-side
“second password” would still authenticate the entire mailbox and would need a
new James credential store, reset/revocation semantics, audit path, and Davis
integration. It would also make the same credential usable by every James
protocol. Davis native app keys already provide per-device naming and
revocation, so the deployment change stays at the Davis boundary.

## Deploy-side checklist (not executable from this repository)

- [ ] Confirm the installed Davis version exposes a non-interactive app-key
      create/list/revoke operation, or add a minimal private helper on
      your-mail-host. Do not automate the dashboard with browser credentials.
- [ ] Give the helper a service identity that can manage app keys only, with no
      Davis database or dashboard-admin password in Email-Ops.
- [ ] Define the private bridge endpoint, authentication, timeout, replay key,
      audit event, rate limit, and redaction policy. Keep it off the public
      calendar proxy unless a reviewed authenticated route is required.
- [ ] Decide where an ephemeral backend CalDAV credential is released. A
      salted verifier cannot be reversed; the bridge or a secret manager must
      hold the usable secret if server-side calendar calls are required.
- [ ] Add the Email-Ops Prisma model/migration only after the bridge contract is
      approved: workspace id, mailbox id, label, Davis reference, salted hash,
      created/revoked/last-used timestamps, and audit linkage. No plaintext.
- [ ] Exercise create → one-time display → iPhone/DAVx5 sync → revoke → failed
      sync, including a cross-workspace and co-member human-mailbox refusal.
- [ ] Update the Email-Ops credential provider binding from the current
      fail-closed implementation and run the backend calendar fake tests plus a
      wire-level Davis smoke test with a disposable account.

Until those gates pass, the existing Email-Ops device page's mailbox-password
reset remains a mailbox-password reset; it is not a per-device calendar
credential and should not be described as one.
