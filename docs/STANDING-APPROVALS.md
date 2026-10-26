# Standing campaigns and phone approval

A human can create a campaign request in Agent Inbox, review its template and
limits, and approve it. PATs and federation identities receive 403 on every
standing-approval operation. Definitions are immutable: renewal or a change to
the sender, template, rules, cap or expiry requires a new request and human
approval. Approving a new revision revokes the earlier active revision of that
campaign in the same transaction. The approver must have access to both
mailboxes if a revision changes the sender.

Each request binds one mailbox ID and its address, one subject and plain-text
template, a positive daily cap, an expiry within 90 days, and optional exact
recipient-domain allow/block lists. The UI's free-mail option stores its displayed
domain list in the request. It is not a dynamically changing provider taxonomy;
additional domains can be entered explicitly. Empty allow lists allow any domain
except those blocked. Domain matching is exact, not a suffix or wildcard match.

`templateSha256` is SHA-256 over fixed-order JSON containing `bodyTemplate`,
sorted `placeholderRules`, `optionalLines`, and `subjects`. It deliberately
excludes the recipient batch. `definitionSha256` separately binds the campaign,
mailbox, sender, template hash, recipient policy hash, cap and expiry. The existing
send-kit body/subject normalization and personalization rules are reused.

The existing agent release of a staged draft first tries an active matching
standing approval at the send-kit gate. It requires the same mailbox and sender,
the approved subject/body, one To recipient, no Cc/Bcc, no attachments and no
HTML body. Any mismatch follows the existing send-kit flow, with its existing
refusal reason. It does not alter compose autonomy, entitlements, mailbox scope,
deferred-send timing, trusted-recipient learning or other approval checks.

Daily limits use the existing **America/New_York calendar day**, including DST.
A transaction locks the grant, rechecks revocation/expiry, counts reservations,
and reserves one slot before the provider is called. This serializes concurrent
sends across processes. `email_messages.standingApprovalId` records the grant;
`standing_approval_uses` records the unique message reservation and time.
Compose/inbox responses also include `standing_approval_id` when present. Daily
usage spans all revisions of the same campaign, so renewal does not reset the
day’s budget.

A provider failure or uncertain outcome retains its reservation. Automatic
retries cannot reuse that message's reservation. This is conservative: the cap
counts authorized attempts, not only successful deliveries. Revocation takes
effect at the next authorization; an already authorized provider handoff cannot
be recalled. The existing human/kit retry path remains available for review.

## Phone links

Pending kit views and new campaign requests include `approval_url`. The existing
approval notifier includes that URL when available. Legacy pending kits receive
a link when next listed or opened. Opening an expired link instructs the human
to get the latest one from the inbox. Links last at most 24 hours, or until the
proposal expires if sooner. The full token travels in the URL fragment and then
in a JSON POST, rather than in request URLs/referrers.

The HMAC signature is domain-separated for links and sessions using the existing
`JWT_SECRET`. A link binds its workspace, kind, target ID, complete definition
and recipient hash. A standing request binds its recipient-rule hash, since it
has no fixed batch. Replacing a kit invalidates its old links, including when
only its expiry changes. Preview does not consume a link. Approval consumes it
and grants approval in one transaction. Concurrent reuse, tampering, a different
target/workspace, expiry, a decided proposal, and loss of review/mailbox access
all fail closed. Merely opening or forwarding a link cannot approve anything.

The `/approve` page requires a signed-in human to load the summary. SSO and local
login return to that approval page. One tap approves the displayed target. An
optional checkbox creates a fixed 30-day, workspace-bound, opaque session in an
HttpOnly, Secure, SameSite=Strict cookie, scoped to `/api/v1/approvals`. Only the
approval controller recognizes it; it cannot read mail, send mail, create or
widen grants, use MCP, or extend itself. Each request rechecks the active user,
workspace review authority and mailbox fence. Explicit bearer credentials take
precedence over cookies on phone, standing, kit-decision and MCP routes, so an
agent token cannot hide behind a human session. JSON requests require `X-Email-Ops-Approval: 1` and
reject cross-site browser requests.

“Forget approvals on this phone” revokes the stored device session and clears its
cookie. Normal logout also clears the cookie. HTTPS is required for remembered
phone sessions even when development web sessions allow insecure cookies.

## API

All paths are relative to `/api/v1`.

| Method and path | Purpose |
| --- | --- |
| `GET /workspaces/:workspaceId/standing-approvals` | Human-only list and fresh pending links |
| `POST /workspaces/:workspaceId/standing-approvals` | Human-only immutable request |
| `POST /workspaces/:workspaceId/standing-approvals/:id/approve` | Human approval with `definition_sha256` |
| `POST /workspaces/:workspaceId/standing-approvals/:id/revoke` | Human revocation, including pending requests |
| `POST /approvals/:workspaceId/:kind/:id/preview` | Human summary; JSON `{ token }` |
| `POST /approvals/:workspaceId/:kind/:id/approve` | Human one-tap approval; JSON `{ token, remember? }` |
| `POST /approvals/:workspaceId/session/forget` | Revoke the current phone session |

Kinds are `send-kit` and `standing`. The corresponding MCP tools are
`request_standing_approval`, `list_standing_approvals`,
`approve_standing_approval`, and `revoke_standing_approval`. They all require a
human identity, regardless of PAT scopes. There is no agent renewal or widening
tool; a human creates and reviews a replacement request.

## Migration and review

Apply `backend/prisma/migrations/20261026180000_standing_approvals_phone_links/migration.sql`
and regenerate Prisma Client before running the changed backend. The migration
adds four RLS-protected tables (`standing_approvals`, `standing_approval_uses`,
`approval_links`, `approval_sessions`), a nullable `standingApprovalId` on
`email_messages`, indexes, constraints, and conditional runtime/read-only role
grants. It does not rewrite existing rows or grants.

No new secret is required. `JWT_SECRET` must be configured; changing it invalidates
existing approval links and remembered sessions. `FRONTEND_URL` should be the
public HTTPS origin for absolute notification links. The existing notifier
configuration controls delivery. The remembered-cookie path assumes the default
`api/v1` API prefix; deployments using a different prefix must align this path.

Unit tests exercise the authorization and transaction seams with in-memory
database/provider doubles. They do not establish real PostgreSQL locking, RLS,
migration execution, provider delivery or mobile-browser behavior. Those need an
authorized integration environment before deployment.
