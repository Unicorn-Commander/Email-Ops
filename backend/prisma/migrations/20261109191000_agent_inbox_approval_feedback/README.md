# Agent-inbox approval evidence

Revision: `20261109191000_agent_inbox_approval_feedback`.

Both SQL files were generated with Prisma 5.22.0 `migrate diff`, comparing the
schema before this revision with the updated schema. No data backfill or defaults
are applied: existing rows keep null evidence. `migration.sql` is applied by the
normal `prisma migrate deploy` workflow. `rollback.sql` is the Prisma-generated
reverse diff, supplied because Prisma does not have a `migrate down` command.
Rolling back discards the four new evidence columns; it preserves existing rows.

New EMAIL inbox items capture `bodySha256` at staging. Approval compares the
plain-text body with that immutable baseline using the existing exact UTF-8
SHA-256 function (no whitespace or line-ending normalization). Missing baselines
keep `editedBeforeSend` null, even when a sent hash is available. HTML-only changes
are outside this existing plain-text hash contract.

Single approval records evidence only after the provider accepts the send. Bulk
approval records the body approved for scheduled delivery, and the existing
single-approval path confirms the sent body when delivery runs. Consumers must
also check the message's send outcome before counting a successful send.

REST and MCP accept optional `factual_correction` on single and bulk approvals;
a bulk value applies to every newly approved email in that request. Omission is
null, distinct from explicit false. The existing `note` input remains available.
Approval audit `detail` stores JSON with the subject, both hashes, edit flag,
factual-correction flag, review note, and (for bulk approval) scheduled send time.
Retries preserve reviewer feedback. List and detail serializers expose the new
nullable fields, including nulls for historical items.
