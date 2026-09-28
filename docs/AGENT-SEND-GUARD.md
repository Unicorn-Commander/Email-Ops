# Agent send guard

Email-Ops keeps the existing workspace/RLS and idempotency boundaries. A compose
retry remains idempotent on `(workspace_id, external_source, external_ref)`.

## Approval authority

Agent-inbox approval is a member review action. Viewer accounts cannot approve or
reject. A human may approve any pending email that the mailbox fence permits. An
agent principal (federation actor or PAT caller) cannot approve an agent-drafted
message to an external domain when that domain is neither a verified workspace
domain nor a trusted correspondent. The refusal is HTTP/MCP 403 and leaves the
item pending. A human is never blocked by this guard.

The exception is a `kit_id` attached at compose time. A human approves a kit with
`approve_send_kit`; the approval stores the workspace, human UC uid, template
SHA-256, and expiry. Approval only bypasses the guard when the current staged
message hashes to that exact, unexpired template. Agents cannot create or renew
kits.

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
