# Changelog

All notable changes to Email-Ops. Dates are the deploy date to the internal line
of record (`email-ops.magicunicorn.dev`).

## [0.6.0] — 2026-07-17

Wave 1 - Truth & safety: copy-truth documentation sweep + login copy updates.

### Added
- **Real triage moves mail.** Triage now moves threads in James (not overlay-only) and no longer reappears on refetch.
- **JMAP send lane.** Sets required `mailboxIds` and saves a copy to Sent.
- **Autonomy fail-safe.** Blocks unregistered/untrusted senders from auto-sending; stages a draft instead.
- **Five new MCP read tools.** `list_threads`, `get_thread`, `search_mail`, `set_read`, `bulk_disposition`.
- **New-mail poll + Refresh.** Added a Refresh button and unread count in the tab title.
- **Self-hosted fonts and favicon.**
- **Frontend security headers.** CSP, HSTS, X-Frame-Options.
- **Hermetic test split + CI.** Unit/integration test split and a Forgejo Actions CI pipeline.

## [0.5.0] — 2026-07-12

Production readiness + operational hardening: a **gated production line** on
`email-ops.unicorncommander.ai`, **off-device backups**, proven **archive-and-purge
durability**, and the **connected-account cleaning** path diagnosed and fixed.

### Added
- **Production stack (gated).** `email-ops.unicorncommander.ai` stood up as project
  `email-ops-prod` (own Postgres, engine, backend, frontend; own Garage prod bucket
  + scoped key; dedicated `uc-customers` Keycloak realm). Launch is gated —
  `UC_ENTITLEMENT_MODE=enforce` + empty access list — so nobody is in without an
  out-of-band grant. RLS verified enforcing (21 FORCE tables, app role reads 0
  tenant rows). Flip steps in `infrastructure/PROD-FLIP-RUNBOOK.md`.
- **Off-device backups.** `scripts/backup.sh <internal|prod>` (logical `pg_dump` as
  the owner role, `pg_restore --list`-verified, 14-day rotation) and
  `scripts/james-backup.sh` (the James mail store) now rsync nightly to **your-prod-host**
  over Tailscale — a genuinely different machine (the Garage "off-box" target runs
  on your-host itself). Cron 02:45 / 02:50 / 02:55.
- **Cleanup empty-state CTA.** The Cleanup page now shows an actionable **Connect**
  button routing to Accounts when no provider is linked (was dead text).

### Fixed
- **Archive verify fails cleanly.** `verify_archive` left the S3 download outside its
  try/except, so a missing/unreadable object raised a 500 instead of returning
  `{success:false}`. Backend already fails closed (purge needs `verified===true`), so
  never data-loss — but the engine now returns a clean result. Proven end-to-end
  against live Garage: create → verify → restore (byte-identical) → purge → gone.
- **Gmail connected-account token no longer dies after ~1 hour.** Connected-account
  cleaning uses **Keycloak-brokered** provider tokens; the `uchub` Google IdP was
  missing offline access, so its token expired hourly with no refresh (Microsoft had
  `offline_access` + `prompt=consent` and worked). Google IdP now carries
  `offlineAccess=true` + `prompt=consent`. **Google + Microsoft IdPs mirrored into
  the `uc-customers` realm** for prod parity (mail scopes + offline + store-token).

### Operator notes
- To activate Gmail cleaning: re-link Google at `/accounts` (Reconnect Google) to
  mint the durable token. Microsoft already works.
- Prod cleaning additionally needs the broker redirect URIs added to the Google
  (project `69011395859`) and Azure (app `77d288a0`) OAuth apps:
  `…/realms/uc-customers/broker/{google,microsoft}/endpoint`.
- Known gaps (not built): no first-class Help section; the in-app AgentChat cannot
  drive the UI (the `ui_*` command bus is MCP-only); no James/JMAP cleaning provider
  (only Gmail/M365 mailboxes are cleanable today).

## [0.4.0] — 2026-07-07

The **Agent Email Command Center** release: the `/mail` surface becomes a
streaming, chat-driven cockpit over the sovereign **Apache James** mailbox, with
a full command-center chrome and a world-class UI polish pass.

### Added
- **Streaming assistant chat** in the mail rail — engine SSE → backend proxy →
  browser, with live token streaming (`POST …/assistant/chat/stream`).
- **Chat can take actions, not just talk.** The assistant stages work into the
  agent-inbox approval queue straight from chat:
  - **Drafts** — `draft_reply` threads a reply onto the right conversation.
  - **Cleanup (native)** — "archive/trash these threads" stages a real JMAP move
    against your **own James inbox**, executed only on human approval
    (`Approve & run`). Trash/Delete cards are styled red; Archive is accent.
  - **Cleanup (external)** — the same flow for a connected Gmail / Microsoft
    account, or a graceful "connect an account" card when none is linked.
- **Command-center chrome across every page** — a far-left section icon-rail
  (Overview · Mail · Approvals · Agents · Mailboxes · Insights · Cleanup ·
  Accounts) that **expands to show titles** (`‹ MENU` toggle, persisted).
- **Slim folders rail** — collapsing the accounts+folders pane now leaves a
  56px avatar rail (one avatar per mailbox with an unread pip, the folder
  glyphs, and the approvals queue) instead of hiding the webmail entirely.

### Changed / polished (UI/UX pass)
- **HTML email bodies follow the app theme, not the OS.** The reader iframe's
  `color-scheme` is now pinned to the resolved app theme and re-renders on
  toggle — fixes white-on-black email bodies for OS-dark users who set the app
  to light, and stale token colours after a theme switch.
- **Consistent attention colour** — the pending-approvals badge is now warning
  (amber) everywhere, including the section rail (was accent/violet there).
- **Consistent keycaps** — one keycap style (5px radius, tabular `mono`) across
  the search hint, command palette, shortcuts help, and composer send hints.
- **Reader destructive tools** (Trash, Report spam) now show a danger hover.
- **A read mailbox shows `0`, not `—`** — `—` is reserved for an unknown count.
- Tabular figures on reader timestamps; lighter segment-control shadow;
  hover affordance on the expanded-message header; larger `?` help glyph;
  the search `⌘K` chip is now a real button that opens the palette; the
  Compose button carries an accessible name below `sm`; standardized
  disabled-button opacity.

### Notes
- Native cleanup reuses the `CLEANUP` agent-inbox kind with a `payload.native`
  discriminator — **no schema migration**.
- The autonomous inbound triage classifier stays **overlay-only**; only
  human-approved chat cleanup ever moves mail in James.

## [0.2.0] — 2026-06-06

Initial internal/dogfood release: SSO → session, external Gmail/M365 cleaner
(analyze/trash/archive/restore/organize), Garage archive vault with restore
round-trip, the EmailOpsPort MCP contract, and the your-host deploy bundle.
See `STATUS.md`.
