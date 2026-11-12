# Agent-inbox item lifecycle

This document describes the lifecycle of an agent-inbox item exactly as the
code implements it today. Every claim cites `file:line`. All example people,
addresses and hosts are fictional placeholders (example.com).

An `AgentInboxItem` is the human-in-the-loop approval record for one outbound
draft (`backend/prisma/schema.prisma:1273`). There is one inbox item per
outbound DRAFT message (`backend/prisma/schema.prisma:189`). The item state is
its own enum and is separate from the message status enum it points at.

## Status values

`AgentInboxState` has exactly three values (`backend/prisma/schema.prisma:190-194`):

- `PENDING`: default; a `mode=draft` compose lands here
  (`backend/prisma/schema.prisma:187`, `backend/prisma/schema.prisma:1288`).
- `APPROVED`: a human approved it and it was handed to the send lane
  (`backend/prisma/schema.prisma:188`).
- `REJECTED`: a human declined it; it never leaves
  (`backend/prisma/schema.prisma:188-189`).

Two related enums classify the item but are not states:

- `AgentInboxKind`: `EMAIL`, `CLEANUP`, `NOTICE`
  (`backend/prisma/schema.prisma:196-200`).
- `AgentInboxApprovalTier`: `OWNER_ADMIN`, `MAILBOX_OWNER`
  (`backend/prisma/schema.prisma:202-205`).

The linked message uses `EmailMessageStatus`
(`QUEUED, SENT, DELIVERED, DRAFT, PENDING_APPROVAL, REJECTED, FAILED, BOUNCED`,
`backend/prisma/schema.prisma:114-123`). The agent-inbox lane is
`PENDING_APPROVAL -> (approve) -> QUEUED`
(`backend/prisma/schema.prisma:103`).

## How an item is created

- A `mode=draft` compose records the message in `PENDING_APPROVAL` and stages
  an `AgentInboxItem` in `PENDING`; the send happens later on approve
  (`backend/src/email/email.service.ts:22-23`,
  `backend/src/email/email.service.ts:2300`).
- A return-to-agent action creates a `NOTICE` item in `PENDING`
  (`backend/src/email/email.service.ts:5048-5064`).

## Allowed transitions

- `PENDING -> APPROVED` on approve. The state flip is a conditional claim
  (`updateMany` where `state = PENDING`)
  (`backend/src/email/email.service.ts:3936`,
  `backend/src/email/email.service.ts:4272-4275`).
- `PENDING -> REJECTED` on reject
  (`backend/src/email/email.service.ts:4541`,
  `backend/src/email/email.service.ts:4615-4623`).
- `APPROVED -> PENDING` when the send is not accepted (see Send failure)
  (`backend/src/email/email.service.ts:4481-4484`).
- `APPROVED -> PENDING` when a recipient is found suppressed
  (`backend/src/email/email.service.ts:4051-4058`).

Non-pending items are terminal for the human actions:

- Approving a non-pending item is a no-op that returns the current view
  (`backend/src/email/email.service.ts:3975-3986`).
- Rejecting a non-pending item is a no-op that returns the current view
  (`backend/src/email/email.service.ts:4568-4576`).
- There is no `APPROVED -> REJECTED` path: a reject cannot unsend delivered
  mail (see the agent-inbox approve spec).

## Approve path (single item)

`approveAgentInboxItem` runs in three phases
(`backend/src/email/email.service.ts:3936`):

1. Validate and authorize in a short transaction
   (`backend/src/email/email.service.ts:3950-3954`). A foreign workspace id
   resolves to null and becomes a 404
   (`backend/src/email/email.service.ts:3959-3966`). An `OWNER_ADMIN` tier item
   requires an `OWNER` or `ADMIN` reviewer
   (`backend/src/email/email.service.ts:3991-4000`). Only the mailbox owner may
   approve a send from a human mailbox
   (`backend/src/email/email.service.ts:4230-4234`). A body edit is refused for
   an agent principal (`backend/src/email/email.service.ts:3947-3949`).
2. Hand the draft to the mail engine outside the transaction
   (`backend/src/email/email.service.ts:4443-4449`). A throwing engine call is
   captured as `accepted: false` (`backend/src/email/email.service.ts:4450-4458`).
3. Record the outcome in a short transaction and flip the item to `APPROVED`
   only on an accepted send (`backend/src/email/email.service.ts:4505-4520`).

The claim happens before leaving the transaction so only the winner calls the
send lane (`backend/src/email/email.service.ts:4260-4290`). On a lost claim the
call returns the current item state and sends nothing
(`backend/src/email/email.service.ts:4276-4290`).

## Bulk approve path

`bulkApproveAgentInboxItems` accepts 1 to 200 ids
(`backend/src/email/email.service.ts:3543-3556`). Per item it reports one of
`approved`, `scheduled`, `already_approved`, `already_rejected`, or `refused`
with a reason:

- Already `APPROVED` or `REJECTED` short-circuits
  (`backend/src/email/email.service.ts:3615-3626`).
- `OWNER_ADMIN` without an `OWNER`/`ADMIN` reviewer is refused
  (`backend/src/email/email.service.ts:3627-3635`).
- Non-`EMAIL` items are approved immediately through the single-item path
  (`backend/src/email/email.service.ts:3636-3639`,
  `backend/src/email/email.service.ts:3852-3869`).
- A suppressed recipient is refused and the schedule is cleared
  (`backend/src/email/email.service.ts:3645-3671`).
- A non-owner on a human mailbox is refused
  (`backend/src/email/email.service.ts:3678-3681`).
- Scheduled `EMAIL` items are claimed with the same conditional `updateMany`
  (`state = PENDING -> APPROVED`) and get their `sendAt` rewritten
  (`backend/src/email/email.service.ts:3790-3830`).

## Return to agent

`returnSendKitToAgent` returns a send kit to its drafting agent
(`backend/src/email/email.service.ts:5001`). It requires a human identity and a
note (`backend/src/email/email.service.ts:5006-5011`). A kit already `RETURNED`
is a no-op (`backend/src/email/email.service.ts:5017-5019`); a `REJECTED` or
`SUPERSEDED` kit cannot be returned
(`backend/src/email/email.service.ts:5020-5025`). On success it creates a
`NOTICE` item in `PENDING` and moves the kit to `RETURNED`
(`backend/src/email/email.service.ts:5048-5073`).

## Standing approvals

For an agent principal, an external recipient must be covered by a standing
approval or a send kit before the draft can be approved
(`backend/src/email/email.service.ts:4076-4148`,
`backend/src/email/email.service.ts:3713-3720`). `reserve` locks the standing
approval row with `FOR UPDATE`, counts same-window uses, and inserts one
reservation with `skipDuplicates`
(`backend/src/approvals/standing-approvals.service.ts:240-291`). A duplicate
reservation raises a conflict
(`backend/src/approvals/standing-approvals.service.ts:281-284`).

## What sends mail and when

- Immediate approve sends during the request: phase 2 calls the engine inline
  (`backend/src/email/email.service.ts:4443-4449`).
- A future `sendAt` makes a single approve a no-op that leaves the item as-is
  (`backend/src/email/email.service.ts:4066-4074`).
- Bulk approval schedules rather than sends: it sets `sendAt`, flips the item to
  `APPROVED`, and leaves the message `PENDING_APPROVAL`
  (`backend/src/email/email.service.ts:3815-3830`).
- The scheduler fires due drafts: it selects items in `APPROVED` or `PENDING`
  whose message is `PENDING_APPROVAL` with `sendAt <= now`, re-checks
  `payload.sends_at`, and calls `approveAgentInboxItem`
  (`backend/src/scheduling/scheduling.service.ts:342-388`).

## Send failure

Confirm-on-success-only: a send the engine did not accept must not flip the
item to `APPROVED` (`backend/src/email/email.service.ts:4473-4478`). On failure
the code stamps the message `FAILED`
(`backend/src/email/email.service.ts:4480`,
`backend/src/email/email.service.ts:6385-6405`), reverts the item to `PENDING`
(`backend/src/email/email.service.ts:4481-4484`), discards any kit token
(`backend/src/email/email.service.ts:4485-4487`), and throws so the surface
shows the reason (`backend/src/email/email.service.ts:4493-4496`). The item
stays `PENDING` for a retry or a reject.

## Operator: a draft seems stuck

Check these in order:

1. Item `PENDING` with a future `sendAt`: it is scheduled and waiting on the
   scheduler clock (`backend/src/email/email.service.ts:4066-4074`,
   `backend/src/scheduling/scheduling.service.ts:342-354`).
2. Item `APPROVED` but message still `PENDING_APPROVAL`: a scheduled draft not
   yet fired; confirm `payload.sends_at` is present and at or before now
   (`backend/src/scheduling/scheduling.service.ts:372-379`).
3. Item `PENDING` but message `FAILED`: a prior send was rejected by the engine;
   the log line reads "NOT approved - send REJECTED"
   (`backend/src/email/email.service.ts:4489-4492`). Retry or reject.
4. Approve throws a suppressed-reason error: a recipient is suppressed and the
   item stays or reverts to `PENDING`
   (`backend/src/email/email.service.ts:4341-4345`,
   `backend/src/email/email.service.ts:4051-4058`).
5. Approve is refused for authority: an `OWNER_ADMIN` item needs an
   `OWNER`/`ADMIN` reviewer
   (`backend/src/email/email.service.ts:3991-4000`), and a human mailbox needs
   its owner (`backend/src/email/email.service.ts:4230-4234`).

## Concurrency

The single-item approve uses a conditional claim so a double click or a
retried request sends once
(`backend/src/email/email.service.ts:4260-4290`). Two concurrent approvals
of the same item also send once: only the caller whose conditional update
claims the row reaches the send lane, and the other gets the current state
(PR #102; covered by `backend/src/agent-inbox/agent-inbox.approve-sends-once.spec.ts`).
