# Agent calendars and approval-backed event proposals

Status: design proposal for gap 36bb78d2

## Decision summary

Use the existing mailbox-to-CalDAV attachment as the transport foundation, but add
an explicit agent calendar binding and an explicit agent-to-calendar grant. Add a
proposal record linked to the agent inbox for writes aimed at a human-owned
calendar. The agent may prepare a proposal and inspect only the data allowed by
its grant. A signed-in human who owns the target calendar must approve it before
the CalDAV write is attempted.

The first lane should be create-only, proposal-only, and disabled by default. It
should target an already connected human calendar, reject invitees in the first
iteration, and use the existing agent-inbox review surface. Agent-owned calendar
bindings can follow in the same model, with read and free-busy access separated
from write access. The current calendar write staging and review paths are
described below. (`backend/src/calendar/calendar.service.ts:321-353`,
`backend/src/email/email.service.ts:4338-4364`)

## 1. How calendars attach today

### Mailbox is the calendar attachment point

`MailboxAccount` is the identity record for a workspace mailbox. It carries the
provider and ownership fields, and it has a relation to `CalendarDeviceKey`, but
there is no calendar account or calendar ownership relation in the schema.
(`backend/prisma/schema.prisma:616-689`,
`backend/prisma/schema.prisma:703-734`)

Every current calendar REST and MCP operation takes both `mailbox_id` and
`calendar_id`. The calendar service first resolves a visible mailbox, restricts
calendar use to the Davis-backed mail providers, obtains credentials for that
mailbox, asks CalDAV for its calendars, and selects the requested calendar by id,
href, or display name. (`backend/src/calendar/calendar.controller.ts:77-157`,
`backend/src/calendar/calendar.service.ts:112-179`)

The CalDAV client derives the calendar home from the mailbox email identity. It
lists calendar collections with `PROPFIND`, reads events and free-busy with
CalDAV reports, and writes events with conditional `PUT` or `DELETE` requests.
(`backend/src/calendar/caldav.client.ts:122-204`,
`backend/src/calendar/caldav.client.ts:206-293`)

The server-side credential resolver asks the private calendar bridge for a
short-lived backend credential using the mailbox identity, caches it in process
memory, and revokes cached bridge keys at shutdown. Email-Ops does not persist the
credential. If the bridge is unavailable, the calendar provider fails closed.
(`backend/src/calendar/bridge-calendar-credentials.ts:18-24`,
`backend/src/calendar/bridge-calendar-credentials.ts:31-90`,
`backend/src/calendar/calendar-credentials.port.ts:4-21`)

Calendar device keys are a separate human-operated path. The local row stores
only bridge metadata and a mailbox foreign key; device-key list, create, and
revoke requests require a human login and a visible Davis-backed mailbox.
(`backend/prisma/schema.prisma:703-734`,
`backend/src/calendar/calendar-devices.controller.ts:35-101`,
`backend/src/calendar/calendar-devices.service.ts:205-247`)

### Agent mailboxes do not imply agent calendar access

`provision_mailbox` can create a shared, human-owned, or agent-owned mailbox.
Agent-owned mailbox creation is a higher-trust provisioning action, and the
default policy is administrator-only. (`backend/src/mcp/mcp.service.ts:298-323`,
`backend/src/mcp/mcp.tools.ts:149-214`,
`backend/prisma/schema.prisma:1528-1559`)

`provision_agent` accepts an optional mailbox account id and passes it into the
agent creation service. The service creates the agent and uses the canonical
`AgentMailbox` binding path for that mailbox. (`backend/src/mcp/mcp.service.ts:326-349`,
`backend/src/mcp/mcp.tools.ts:216-256`,
`backend/src/agents/agents.service.ts:70-123`)

The `AgentMailbox` join grants only `READ`, `SEND`, or `BOTH` mail access and
marks one binding as the primary From identity. It has no calendar id, calendar
permission, free-busy permission, or approval-owner field. The agent view also
describes the binding as an act-through mail permission, not calendar ownership.
(`backend/prisma/schema.prisma:1461-1491`,
`backend/src/agents/agents.types.ts:11-17`,
`backend/src/agents/agents.service.ts:208-254`)

The member-owned mailbox scope currently resolves only human-owned mailboxes for
an OWNED member scope because there is no human-manager relation for agents.
That means an agent calendar feature cannot safely infer access from the existing
mailbox visibility rule. (`backend/src/common/mailbox/mailbox-scope.ts:118-145`)

One implementation inconsistency is worth preserving as a migration concern:
the REST agent-create path applies both `agent.create` and, when a mailbox is
attached, `agentMailbox.edit`; the MCP `provision_agent` path currently checks
only `agent.create`. (`backend/src/agents/agents.controller.ts:223-250`,
`backend/src/mcp/mcp.tools.ts:235-255`)

### Current calendar tools and approval behavior

`list_calendars`, `list_events`, and `find_free_time` are read-only MCP tools
over the mailbox and calendar ids supplied by the caller. `create_event`,
`update_event`, and `cancel_event` accept an optional `approved` flag.
(`backend/src/mcp/mcp.service.ts:1685-1736`,
`backend/src/mcp/mcp.service.ts:1738-1793`)

For an unapproved calendar write, `CalendarTools` creates a
`calendar_event_draft` payload and stages it as a `NOTICE` agent-inbox item with
the `MAILBOX_OWNER` approval tier. With `approved=true`, the tool requires the
additional PAT scope `agent-inbox:approve` and calls the CalDAV write directly.
(`backend/src/calendar/calendar.tools.ts:69-92`,
`backend/src/calendar/calendar.tools.ts:123-147`,
`backend/src/calendar/calendar.service.ts:321-353`)

The approval service recognizes a calendar payload in a `NOTICE`, applies the
CalDAV operation, and only then marks the inbox item `APPROVED` while recording
the result and an audit event. A failed calendar configuration leaves the item
pending. (`backend/src/email/email.service.ts:3950-3992`,
`backend/src/email/email.service.ts:4338-4364`)

The generic agent-inbox REST review gate currently requires an active workspace
member or higher, while the MCP approval tool is exposed to a principal holding
`agent-inbox:approve`. The separate approval controller has an explicit
human-only check, but the calendar approval branch does not currently use that
check. (`backend/src/common/workspace/membership.service.ts:173-199`,
`backend/src/mcp/mcp-scopes.ts:57-60`,
`backend/src/approvals/human-approval.ts:12-52`,
`backend/src/agent-inbox/agent-inbox.controller.ts:500-585`)

## 2. Options

### A. Agent owns its own calendar

Treat an agent calendar as a calendar collection attached to an agent-owned
mailbox. The agent gets a binding to one discovered CalDAV calendar, rather than
being allowed to enumerate every calendar reachable through the mailbox.

The binding should grant these capabilities independently:

- `READ_EVENTS`, which allows event details.
- `READ_FREE_BUSY`, which exposes only busy intervals.
- `WRITE_OWN`, which allows writes to the agent-owned target.

The mailbox must be `ownerKind=AGENT`, the binding must point to the same agent,
and the agent must be active and not paused. A mailbox that is merely bound for
mail sending must not automatically receive calendar access. Device credentials
remain a human-facing feature; server-side agent operations use the existing
short-lived bridge resolver.

This option gives an agent a durable place for reminders and internal planning.
It does not grant access to a human calendar, and it avoids using the human's
credentials. It still needs policy for invitees, recurrence, event updates, and
whether agent-owned writes notify external attendees.

### B. Agent proposes an event on a human calendar

Add a proposal operation with an explicit target mailbox and calendar. The agent
submits the event details and an optional reason. The server validates the target
and grant, snapshots the target identity and calendar id, and writes a pending
proposal linked to an agent-inbox item. No CalDAV write occurs in this request.

The human calendar owner reviews the event in the agent inbox. Approval must:

1. Recheck the grant, mailbox owner, calendar target, agent state, and workspace.
2. Revalidate the event payload and any stale ETag or target snapshot.
3. Perform the CalDAV create.
4. Mark the proposal and inbox item approved only after the write succeeds.

Rejection marks the proposal rejected and performs no external call. The agent
must not be able to set an `approved` input flag for a human-owned target, and
the existing direct-write path should reject that shape once the feature flag is
enabled.

This option reuses the existing review card, state transitions, audit event, and
CalDAV service. The current paths provide those pieces, but the option needs a
stricter approval identity check and a target-specific permission model so
workspace visibility is not mistaken for delegation. (`backend/src/agent-inbox/agent-inbox.controller.ts:349-365`,
`backend/src/email/email.service.ts:4338-4364`,
`backend/prisma/schema.prisma:1494-1525`)

## 3. Recommendation and first lane

Recommend the hybrid model, delivered in this order:

1. Ship human-calendar `propose_event` first. It is the smallest useful lane
   because the CalDAV transport and agent-inbox staging/application paths already
   exist. (`backend/src/calendar/caldav.client.ts:174-293`,
   `backend/src/calendar/calendar.service.ts:321-388`,
   `backend/src/email/email.service.ts:4338-4364`)
2. Add agent-owned bindings next, using the same binding and capability model.
3. Add updates, cancellations, recurrence, invitees, and optional standing
   approvals only after create-only behavior has operational evidence.

Put the first lane behind `AGENT_CALENDAR_PROPOSALS_ENABLED`, defaulting to
false. When enabled, support only a create proposal for one existing calendar,
with no attendees and no external notification semantics. Keep read events and
free-busy subject to an explicit grant. Do not expose direct human-calendar
writes through `approved=true`.

The first lane should add an MCP `propose_event` operation and a matching service
method. The operation should identify the requesting registered agent, not accept
an arbitrary free-text provenance label. It should return a proposal id, target
summary, pending state, and the review surface location without returning bridge
credentials or broad calendar data.

## 4. Additive data model

All changes below are additive. Existing mailbox, agent, inbox, and CalDAV data
remain valid.

### `AgentCalendarBinding`

Add a workspace-scoped table with:

- `id`, `workspaceId`, `agentId`, and `mailboxId` foreign keys.
- `calendarId` as the remote calendar identifier captured from discovery.
- `access` as a capability enum, initially `READ_EVENTS`, `READ_FREE_BUSY`, or
  `WRITE_OWN`.
- `enabled`, `grantedByUcUid`, `createdAt`, `updatedAt`, and optional
  `revokedAt`.

Require uniqueness over workspace, agent, mailbox, and calendar. Do not store a
CalDAV password, bridge secret, or secret hash. Resolve credentials through the
existing bridge port.

### `AgentCalendarGrant`

Add a separate grant table for delegation to a human-owned calendar:

- `workspaceId`, `agentId`, `targetMailboxId`, and optional `targetCalendarId`.
- `canReadEvents`, `canReadFreeBusy`, and `canProposeCreate` booleans, or an
  equivalent capability enum.
- `grantedByUcUid`, `createdAt`, `expiresAt`, and `revokedAt`.

The target mailbox is the authorization anchor. At use time, require that it is
still human-owned and that the target owner is still the approver. A grant should
not contain a copied personal address or a credential. A human calendar owner or
an explicitly authorized workspace administrator may create and revoke grants;
the default first lane should require the calendar owner to approve every
proposal.

### `CalendarProposal`

Add a proposal table linked one-to-one to `AgentInboxItem`:

- `agentInboxItemId`, `workspaceId`, `agentId`, `targetMailboxId`, and
  `targetCalendarId`.
- `operation`, initially `CREATE`, plus a validated event JSON payload.
- target owner-kind snapshot, target owner identity reference, event uid if
  assigned, and the remote href or ETag after application.
- `approvedByUcUid`, `approvedAt`, `appliedAt`, and `rejectedAt`.

The inbox state remains the review lifecycle. The proposal row supplies typed,
queryable target data and an idempotency boundary without overloading arbitrary
JSON. Keep the existing `AgentInboxItem.payload` during migration so old calendar
drafts can still be reviewed and applied. (`backend/prisma/schema.prisma:1269-1311`,
`backend/src/calendar/calendar.service.ts:83-101`,
`backend/src/email/email.service.ts:3964-3992`)

## 5. Permission model

The authorization order should be:

1. Resolve the workspace and authenticated agent principal.
2. Resolve the registered `Agent` by workspace and stable agent identity. Require
   `active=true` and `paused=false`.
3. For an agent-owned calendar, require an enabled `AgentCalendarBinding` whose
   mailbox is `ownerKind=AGENT` and whose agent is the same agent.
4. For a human target, require an enabled `AgentCalendarGrant` for that exact
   agent and target mailbox. A calendar-specific grant wins over a mailbox-wide
   grant only when it is at least as restrictive.
5. Require the target mailbox to be visible and Davis-backed, then rediscover the
   calendar before staging or applying.
6. Require a human approval session for a human-owned target. The approver must
   be the current target owner, or an administrator only if a future workspace
   policy explicitly permits an override. No agent PAT, agent MCP call, standing
   approval, or `approved=true` flag satisfies this requirement.

Grant, revoke, proposal, approval, rejection, application, and failed-application
events should be appended to the existing agent action audit stream. A grant
must be revocable without deleting the agent or mailbox. Existing mailbox access
levels must not be silently interpreted as calendar grants.

## 6. Risks and mitigations

- **Direct-write bypass:** the current calendar tool can write when
  `approved=true` is supplied with the extra approval scope. Reject that shape for
  human-owned targets behind the flag, and make the proposal path the only human
  target write path. (`backend/src/calendar/calendar.tools.ts:69-92`,
  `backend/src/mcp/mcp-scopes.ts:137-177`)
- **Approval race:** ownership, grant, calendar existence, and agent pause state
  can change after staging. Recheck all of them immediately before CalDAV write,
  and leave the item pending if the write cannot be safely authorized.
- **Duplicate events:** a retry after a successful remote write can duplicate a
  create. Use a deterministic proposal-derived UID and an idempotency constraint,
  then record the remote href and ETag.
- **Stale calendar metadata:** calendar ids and hrefs can change or be removed.
  Rediscover by mailbox and compare the target snapshot before application.
- **Credential exposure:** bridge credentials are live secrets even when they are
  not persisted. Keep the existing in-memory resolver, redact exceptions, use
  short TTLs, and never put credentials in proposal payloads or inbox views.
  (`backend/src/calendar/bridge-calendar-credentials.ts:18-90`,
  `backend/src/calendar/calendar-bridge.client.ts:33-36`)
- **Privacy leakage:** event details and free-busy data reveal more than a
  mailbox send binding. Keep event reads and free-busy as separate grants, log
  access, and default a new agent grant to proposal-only.
- **Attendee side effects:** an event with invitees can send notifications or
  create obligations. Exclude attendees from the first lane; add a separate
  approval reason and policy later.
- **Time and recurrence errors:** the current service normalizes dates, timezones,
  recurrence, and attendees before serialization. Keep that validation in one
  service and add focused tests for all-day boundaries, DST, recurrence, ETags,
  and retries. (`backend/src/calendar/calendar.service.ts:56-80`,
  `backend/src/calendar/calendar.service.ts:278-318`)
- **Provisioning mismatch:** MCP agent provisioning currently does not apply the
  REST path's second mailbox-binding policy check when a mailbox is attached.
  Close or explicitly defer that mismatch before allowing calendar grants to be
  created through provisioning. (`backend/src/agents/agents.controller.ts:223-250`,
  `backend/src/mcp/mcp.tools.ts:235-255`)
- **Legacy drafts:** existing `NOTICE` payloads have no typed proposal row. Keep
  the current payload parser and make the new table optional during migration so
  pending items are not stranded. (`backend/src/calendar/calendar.service.ts:83-101`,
  `backend/src/email/email.service.ts:3964-3992`)
