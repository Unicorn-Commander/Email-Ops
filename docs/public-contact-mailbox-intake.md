# Public product contact mailbox intake

Status: first-cut implementation ready for a single mailbox. Public-page wiring is deliberately out of scope and requires Aaron's approval.

## Decision

Use **one agent-owned mailbox per public contact purpose** in the first rollout, rather than a central triage mailbox that routes to several owners.

For the first mailbox, create a sovereign `MailboxAccount` with `ownerKind=AGENT`, bind it to the designated contact agent, and enable its inbound watcher. This makes ownership, thread context, audit provenance, pause controls, and the reply approval queue unambiguous. It also avoids a new cross-agent routing policy before there is evidence that multiple public mailboxes need it.

The later central-triage option is reserved for a real many-mailbox need. It must classify before routing, record the chosen owner and reason, and fail closed to a human review queue when the owner is uncertain. It must never fan a message to multiple agents.

## First-cut flow

```text
public sender -> sovereign AGENT mailbox -> inbound watcher (once/minute)
  -> sender policy + Cleaner/SpamPort classification
  -> SPAM: Spam disposition only; no LLM call and no reply draft
  -> clean/unsure: bound agent reply runtime
  -> agent-inbox EMAIL draft -> human approval -> canonical send lane
```

The running code has two independent feature dials, both default-off:

- `INBOUND_WATCHER_ENABLED=true` activates the one-minute sovereign-mailbox poll.
- `AGENT_REPLY_RUNTIME_ENABLED=true` permits a clean inbound to create a reply draft. It does not grant autonomous sending; approval remains mandatory until the existing autonomy gate permits an exception.

Activation must use a mailbox address and agent binding selected by Aaron. No address is published, no DNS is changed, and no production setting is changed by this task.

## Spam and abuse controls

1. Sender `BLOCK` policy and a Cleaner/SpamPort `spam` verdict place a thread in Spam before the reply runtime. Spam gets no agent/LLM work and no draft.
2. Automated senders (`no-reply`, bounces, postmaster, and variants) are suppressed by the reply runtime.
3. The runtime limits each mailbox to `EMAIL_OPS_AGENT_DRAFTS_PER_MAILBOX_PER_DAY` drafts per rolling 24 hours (default 20), and caps runtime auto-sends per thread at five in 24 hours.
4. Autoreply headers, self-mail, and same-workspace agent-mail senders are loop-suppressed.
5. Keep public addresses off product pages in this first cut. Prefer a rate-limited, CAPTCHA-protected contact/booking form when Aaron approves a public path; it can deliver to this mailbox while preserving the mail-side controls.

## Response SLA and operating model

- The watcher target is a one-minute poll; an inbound classified clean should appear as a pending agent-inbox draft within five minutes under normal service conditions.
- A human reviewer owns the queue: acknowledge or approve/reject during business hours within one business day. Urgent/legal/security messages are manually escalated rather than auto-sent.
- Treat a sustained queue age over one business day, a watcher error, or a mailbox draft-cap hit as an operational alert and pause public exposure until reviewed.
- Review Spam and blocked-sender outcomes weekly for false positives; only explicit, auditable sender policies override the engine verdict.

## Verification and rollout checklist

1. Create/bind one non-public AGENT mailbox in a non-production workspace.
2. Enable the two flags only in that controlled environment.
3. Send a normal external test message and assert: inbound cursor advances, a pending agent-inbox EMAIL draft exists, and approval uses the normal send lane.
4. Send a spam-policy or SpamPort-positive test message and assert: its disposition is Spam, no agent-inbox draft is created, and no LLM call is made.
5. Verify the daily mailbox cap and pause switch before considering public exposure.
6. Obtain Aaron's approval before publishing any address, form, booking integration, DNS, or production configuration.
