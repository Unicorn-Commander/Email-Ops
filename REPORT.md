# Task 0ff202c6 report

What changed
- `1197c72 docs: design vendor pitch notice auto-acknowledge`
- `5cecdac docs: make customer guard global`
- Added `docs/design/2026-11-12-mail-rule-auto-acknowledge.md` only.
- The proposal is opt-in and off by default, with explicit `vendor_pitch`
  classification, trusted-sender, reply-thread, Customer-Ops, content, cap, and
  idempotency guards.
- Specified AUTO_ACKNOWLEDGED state, Auto-acknowledged filter, reason snapshot,
  append-only audit, human undo to PENDING, data/API/UI changes, tests, and
  dogfood rollout for `support@majiks.studio`.

Verification
- `git diff --check`: passed.
- Unicode em-dash scan on the design doc: no matches.
- Citation scan confirmed every cited source path exists in the repository.
- Read `.forgejo/workflows/ci.yml`: this is documentation-only, so backend,
  frontend, and cleaner-engine CI lanes do not apply; no code tests were run.

Left and why
- No implementation, migration, API, UI, or tests were changed by design.
- Customer-Ops customer-status contract and provider reply evidence remain
  implementation dependencies for a future task.

Aaron must decide
- Confirm the first mailbox and Customer-Ops guard semantics.
- Confirm the recommended 10-per-rule-per-day cap, hard maximum 50.
- Confirm whether undo is for all inbox reviewers or owners/admins only.
