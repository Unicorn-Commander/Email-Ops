# Agent send guard

Email-Ops keeps the existing workspace/RLS and idempotency boundaries. A compose
retry remains idempotent on `(workspace_id, external_source, external_ref)`.

## Approval authority

Agent-inbox approval is a member review action. Viewer accounts cannot approve or
reject. A human may approve any pending email that the mailbox fence permits. A
human principal is never blocked by the agent send-kit guard. An agent principal
(federation actor or PAT caller) cannot approve an agent-drafted message to an
external domain when that domain is neither a verified workspace domain nor a
trusted correspondent. The refusal is HTTP/MCP 403, carries a machine-readable
`reason`, and leaves the item pending.

The exception is a `kit_id` attached at compose time. The lifecycle is deliberately
agent-first and human-visible:

1. The agent calls `propose_send_kit` with a short `title` and the complete kit
   definition. Email-Ops builds the definition, lower-cases and retains the
   recipient addresses for review, derives `recipientHashes`, and returns the
   `template_sha256`. The row is `PROPOSED`; it cannot authorize a send.
2. The owner opens the Agent Inbox's **Send kits** section. The screen shows the
   sender, subjects, exact template, highlighted placeholders, optional lines,
   recipient list, cap, expiry, note, and the first 12 hash characters.
3. The human approves by sending only `kit_id` and the full displayed hash, or
   rejects with an optional note. The server refuses a changed hash, a non-
   `PROPOSED` row, or an expired proposal. Only `APPROVED` and unexpired kits
   pass the agent send guard.

The L1b full-definition `approve_send_kit` form remains accepted for compatibility.
It can create a legacy `APPROVED` row when no proposal exists, but it cannot change
an existing approved kit. The request contains `body_template`, optional
`placeholder_rules`, `optional_lines`, `subjects`, `recipients`, `from_address`,
`cap_per_day`, `expires_at`, and `template_sha256`. The server lower-cases and
retains each recipient address and hashes it for the guard. It computes
`template_sha256` over this canonical JSON object, in this property order, with
`recipientHashes` sorted:

```json
{
  "bodyTemplate": "...",
  "placeholderRules": { "first_name": "...", "token": "..." },
  "optionalLines": [],
  "subjects": ["..."],
  "recipientHashes": ["..."],
  "fromAddress": "...",
  "capPerDay": 25
}
```

Approval is refused if the supplied hash does not match the stored proposal or
server-computed legacy definition. By default `{first_name}` accepts a Unicode name up to 40 characters
and `{token}` accepts exactly 16 lower-case hexadecimal characters. The body is
matched as one anchored regular expression after CRLF-to-LF normalization; the
guard escapes literal text and substitutes each placeholder rule. A kit also
requires the staged sender, one To recipient, no Cc/Bcc, no attachments, an
allowed subject, a recipient hash in the kit, and fewer than `cap_per_day`
messages sent during the current UTC day.

### Worked personalised wave

The agent first proposes this three-line template (line numbers are zero-based) for
two recipients:

```json
{
  "kit_id": "welcome-wave-2026-09",
  "title": "September secure-link welcome wave",
  "body_template": "{first_name},\n\nYour secure link: {token}",
  "optional_lines": [0],
  "subjects": ["Your secure link"],
  "recipients": ["alice@example.com", "bob@example.com"],
  "from_address": "outreach@example.org",
  "cap_per_day": 25,
  "expires_at": "2026-10-01T00:00:00Z",
  "note": "Use only the approved secure-link copy.",
  "template_sha256": "<server returns this after propose_send_kit>"
}
```

The server returns `state: "PROPOSED"`, the two lower-cased `recipients`, and a
full hash such as `<full template hash>`. The owner sees `September secure-link
welcome wave` in Agent Inbox, expands the recipient list, checks the highlighted
`{first_name}` and `{token}` chips, and clicks Approve. The browser sends:

```json
{
  "kit_id": "welcome-wave-2026-09",
  "template_sha256": "<full template hash>"
}
```

The row becomes `APPROVED`. For Alice, the staged body may be `Ana,\n\nYour secure link: 0123456789abcdef`.
When no name is known, line 0 and its following blank line are omitted, so the
body is `Your secure link: 0123456789abcdef`. Alice and Bob are retained for the
human review and their recipient hashes authorize only those addresses. Each
message must still use the approved sender and subject and consumes one of the 25
daily sends. A different hash, a `PROPOSED`/`REJECTED` kit, or an expired kit
returns `kit_not_approved`, `kit_rejected`, or `kit_expired` respectively.

Trust learning is opt-in. `trust_recipients` defaults to false; only an explicit
true learns recipients for future autonomous replies. Rejection never learns.

## Deferred sends

`mode=draft` may include `send_at`. It must be an ISO-8601 timestamp at least five
minutes and no more than fourteen days in the future. The inbox item remains
`pending`, exposes `sends_at`, and is cancellable with reject/Skip before the
timestamp. The existing scheduling worker claims due items and sends them through
the same approval/send lane. Rejected items are not eligible.

## Attachments

Compose accepts `{documentId}` for an Email-Ops-stored document readable through
the selected mailbox, or `{filename, contentType, contentBase64}` for inline
bytes. The legacy snake-case and uploaded `blob_id` forms remain compatible.
Defaults are at most five files, 10 MiB per file, 20 MiB decoded total, and
`pdf`, `png`, `jpg`, `txt`, `csv`, `md`, `docx`, and `xlsx`; these are configurable
with `EMAIL_OPS_ATTACHMENT_MAX_FILES`,
`EMAIL_OPS_ATTACHMENT_MAX_FILE_BYTES`,
`EMAIL_OPS_ATTACHMENT_MAX_TOTAL_BYTES`, and
`EMAIL_OPS_ATTACHMENT_ALLOWED_TYPES`. Attachment names, sizes, and MIME types
are exposed in the agent inbox before approval. Gmail/Graph and Postmark receive
inline provider attachments; James uses its JMAP blob lane. A configured lane
that cannot carry the requested form refuses compose before staging or sending.

## Operations

The existing additive storage is reused: `EmailMessage.attachments` retains the
staged metadata/content and `OutboundAttachment` stores RLS-fenced external
document bytes. No new migration is required for this change. The normal
your-host steps remain:

```sh
cd backend
npx prisma migrate deploy
npm run prisma:generate
```

Ensure the normal scheduling worker is enabled (the default is a 30-second sweep;
`SCHEDULING_WORKER_DISABLED=true` disables it). The frontend already has the
agent-inbox review surface; this API adds `sends_at` and attachment metadata for
the UI badge/Skip treatment.
