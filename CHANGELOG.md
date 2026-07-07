# Changelog

All notable changes to Email-Ops. Dates are the deploy date to the internal line
of record (`email-ops.magicunicorn.dev`).

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
