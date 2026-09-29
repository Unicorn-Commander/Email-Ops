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

The exception is a `kit_id` attached at compose time. A human approves the full
send-kit definition with `approve_send_kit`; agents cannot create or renew kits.
The request contains `body_template`, optional `placeholder_rules`,
`optional_lines`, `subjects`, `recipients`, `from_address`, `cap_per_day`,
`expires_at`, and `template_sha256`. The server hashes each lower-cased recipient
address and stores only those hashes. It computes `template_sha256` over this
canonical JSON object, in this property order, with `recipientHashes` sorted:

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

Approval is refused if the supplied hash does not match that server-computed
definition. By default `{first_name}` accepts a Unicode name up to 40 characters
and `{token}` accepts exactly 16 lower-case hexadecimal characters. The body is
matched as one anchored regular expression after CRLF-to-LF normalization; the
guard escapes literal text and substitutes each placeholder rule. A kit also
requires the staged sender, one To recipient, no Cc/Bcc, no attachments, an
allowed subject, a recipient hash in the kit, and fewer than `cap_per_day`
messages sent during the current UTC day.

### Worked personalised wave

This is a three-line template (line numbers are zero-based) for two recipients:

```json
{
  "kit_id": "welcome-wave-2026-09",
  "body_template": "{first_name},\n\nYour secure link: {token}",
  "optional_lines": [0],
  "subjects": ["Your secure link"],
  "recipients": ["alice@example.com", "bob@example.com"],
  "from_address": "outreach@example.org",
  "cap_per_day": 25,
  "expires_at": "2026-10-01T00:00:00Z",
  "template_sha256": "<sha256 of the canonical definition>"
}
```

For Alice, the staged body may be `Ana,\n\nYour secure link: 0123456789abcdef`.
When no name is known, line 0 and its following blank line are omitted, so the
body is `Your secure link: 0123456789abcdef`. Alice and Bob are approved as
recipient hashes; their raw addresses are not stored on the kit. Each message
must still use the approved sender and subject and consumes one of the 25 daily
sends.

Trust learning is opt-in. `trust_recipients` defaults to false; only an explicit
true learns recipients for future autonomous replies. Rejection never learns.

## Deferred sends

`mode=draft` may include `send_at`. It must be an ISO-8601 timestamp at least five
minutes and no more than fourteen days in the future. The inbox item remains
`pending`, exposes `sends_at`, and is cancellable with reject/Skip before the
timestamp. The existing scheduling worker claims due items and sends them through
the same approval/send lane. Rejected items are not eligible.

## Attachments

Compose accepts up to five files and 10 MB decoded total. The direct MCP/REST
shape is `{filename, content_type, content_base64}`; the existing uploaded
`blob_id` shape remains compatible. Attachment names and sizes are exposed in the
agent inbox. Bytes are carried through connected Gmail/Graph MIME/fileAttachment
lanes and through the James/JMAP multipart lane; a lane refuses delivery rather
than silently dropping an attachment.

## Operations

Apply the additive Prisma migration before dogfood traffic. No new environment
variable is required. The normal your-host steps are:

```sh
cd backend
npx prisma migrate deploy
npm run prisma:generate
```

Ensure the normal scheduling worker is enabled (the default is a 30-second sweep;
`SCHEDULING_WORKER_DISABLED=true` disables it). The frontend already has the
agent-inbox review surface; this API adds `sends_at` and attachment metadata for
the UI badge/Skip treatment.
