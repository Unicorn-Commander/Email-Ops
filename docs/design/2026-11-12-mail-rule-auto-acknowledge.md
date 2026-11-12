# Opt-in auto-acknowledge for vendor-pitch mail-rule notices

Status: design proposal for ADD 107

This is a design document only. It does not change the mail-rule or agent-inbox
implementation.

## Decision summary

Add an explicit, per-rule auto-acknowledge setting. It is disabled by default and
can only be enabled when the rule declares the exact classification
`vendor_pitch`. A matching notice is retained as an agent-inbox item, but its
state becomes `AUTO_ACKNOWLEDGED` only when every safety predicate passes. The
item remains visible in a dedicated Auto-acknowledged filter with a saved reason.
Undo is a human-only action that restores the item to `PENDING` and records the
undo. No mail is sent, deleted, moved, or marked read by this feature.

The first lane should use a rule-owned classification, not an opaque model
verdict. The rule already supplies the narrow match condition. A future semantic
classifier may be added behind the same decision contract, but it must run on a
local model only, never a paid or frontier API, and any unavailable, uncertain,
or malformed result must leave the notice pending.

## 1. Current behavior and the gap

Mail rules are per-mailbox rows with `match` and `actions` JSON, plus enabled,
priority, hit-count, and timestamps. There is no auto-acknowledge setting or
classification field today. (`backend/prisma/schema.prisma:1129-1155`,
`backend/src/mail-rules/mail-rules.types.ts:32-62`)

The rule engine currently accepts the fields `from`, `to`, `subject`, and
`fromDomain`, with string operators such as equality, containment, prefix, and
suffix. It evaluates enabled rules in priority order and stops after a matching
`STOP` action. (`backend/src/mail-rules/rule-engine.ts:27-34`,
`backend/src/mail-rules/rule-engine.ts:78-112`)

For an inbound message, the applicator currently passes sender, real To
recipients, and subject into that engine. It collects the matched rule ids and
executes each action in order. (`backend/src/mail-rules/mail-rules.service.ts:243-284`)

The `NOTIFY` action creates an `AgentInboxItem` with kind `NOTICE`, a
`mail_rule_notice` payload containing the rule, mailbox, thread, optional
message id, sender, subject, and received time, and state `PENDING`. The notice
has no staged outbound message and requires the mailbox-owner approval tier.
(`backend/src/mail-rules/mail-rules.service.ts:348-368`,
`backend/src/mail-rules/mail-rules.service.ts:619-658`)

The notice open target is resolved from `threadId` and `mailboxId` in the
payload, then the UI fetches the linked thread for preview. (`frontend/components/agent-inbox/queue.ts:7-44`,
`frontend/app/agent-inbox/page.tsx:1461-1491`)

Approving a `NOTICE` only changes the inbox item to `APPROVED` and records an
approval event; it does not send or change a message. Rejecting a pending notice
changes it to `REJECTED` and records a rejection event. (`backend/src/email/email.service.ts:4002-4029`,
`backend/src/email/email.service.ts:4537-4595`)

The backend state enum currently contains only `PENDING`, `APPROVED`, and
`REJECTED`, while `NOTICE` is an item kind rather than a state.
(`backend/prisma/schema.prisma:184-205`)

The REST query currently accepts only `pending`, `approved`, or `rejected`; the
default list and pending count read only `PENDING` items. (`backend/src/agent-inbox/agent-inbox.controller.ts:116-120`,
`backend/src/agent-inbox/agent-inbox.controller.ts:618-628`,
`backend/src/email/email.service.ts:2726-2747`,
`backend/src/email/email.service.ts:2775-2795`)

The browser client mirrors those three states, and its queue filter compares the
item state directly. The existing tabs are Pending, Auto-sent, and History, so
there is no auto-acknowledged lane. (`frontend/lib/api.ts:389-420`,
`frontend/components/agent-inbox/queue.ts:3-5`,
`frontend/components/agent-inbox/queue.ts:60-89`,
`frontend/app/agent-inbox/page.tsx:66-84`)

There is no current vendor-pitch classification in the mail-rule path. The
cleaner engine has a separate LLM categorizer that returns category, confidence,
and reason from message metadata only. Its default model is local, but the
shared generator can fall back to a configured frontier model, so it must not be
called by this feature as-is. (`cleaner-engine/ai/llm_analyzer.py:17-46`,
`cleaner-engine/ai/llm_analyzer.py:118-139`,
`cleaner-engine/ai/llm_analyzer.py:167-187`)

The inbound rule message currently carries thread and provider message ids,
sender, real To recipients, subject, forwarded marker, and received time. It
does not carry an existing-customer verdict, a reply-to-our-thread verdict, or a
Customer-Ops contact id. (`backend/src/mail-rules/mail-rules.types.ts:64-81`)

Email-Ops stores a `contactId` as a thin Contact-Ops reference on its own
message rows, while received message bodies remain in the mail engine. That is
not enough to infer that an inbound sender is an existing customer.
(`backend/prisma/schema.prisma:810-839`)

Trusted correspondents are currently an outbound auto-send allowlist with
address or domain scope. They can be used as an explicit opt-out for this
feature, but they are not a customer directory. (`backend/prisma/schema.prisma:1214-1255`,
`backend/src/trusted-correspondents/trusted-correspondents.service.ts:1-11`)

## 2. Proposed eligibility contract

Auto-acknowledge only a `NOTICE` created by the same rule whose setting enabled
the feature. Evaluate the following predicates in one workspace transaction:

| Predicate | Required result | Failure behavior |
| --- | --- | --- |
| Feature setting | `enabled=true` and classification exactly `vendor_pitch` | Keep `PENDING` |
| Rule match | The rule itself matched the message | Keep `PENDING`; never infer from a neighboring rule |
| Trusted correspondent | Sender matches no trusted address or trusted domain | Keep `PENDING` |
| Reply relationship | Message is not a reply to an existing thread with an outbound message from the mailbox | Keep `PENDING` |
| Customer-Ops guard | Customer-Ops says the sender is not an existing customer; for mail to the configured `support@` identity, the support-specific customer check also passes | Keep `PENDING`; any customer, unknown, or unavailable result is unsafe |
| Content safety | No attachment, no spam verdict, and no forwarded marker | Keep `PENDING` |
| Daily cap | The rule has not reached its UTC-day cap | Keep `PENDING` and record `cap_reached` |
| Idempotency | This inbound message has not already received a decision from this rule | Do not create a second decision |

The no-customer guard applies to every eligible message. In addition, the first
dogfood lane applies a stricter check to the configured support mailbox,
initially `support@majiks.studio`. If any recipient is a configured
customer-support address and the sender is a known Customer-Ops customer, the
feature never auto-acknowledges. Unknown customer status is treated as customer
or unknown, never as safe.

The reply guard should use provider thread evidence, not subject text. A thread
with a prior outbound message from the same mailbox is a reply-sensitive
conversation even if the subject looks like a pitch. Missing thread history,
missing headers, or a provider read failure blocks auto-acknowledge.

The sender trust check should use the existing address and domain scopes. A
trusted sender is an explicit human signal that beats the vendor-pitch rule.
This check is separate from Customer-Ops identity and does not turn a trusted
correspondent into a customer.

### Classification source

For the first lane, the classification comes from the rule configuration:

```text
auto_acknowledge:
  enabled: true
  classification: vendor_pitch
  daily_cap: 10
```

The UI must require the operator to choose `vendor_pitch` from a fixed enum. It
must not infer the label from a rule name, a free-text note, or a model response.
The rule's existing deterministic conditions remain the explainable match, and
the stored decision reason lists those conditions by field and value.

If a later product decision requires semantic classification from message text,
add a small local-only classifier that returns exactly
`vendor_pitch`, `not_vendor_pitch`, or `unknown`, with a confidence and model
version. The classifier must accept only an allowlisted local model id, must not
fall back to the existing frontier setting, must not send data to a paid API,
and must fail closed on timeout, low confidence, parse failure, or unavailable
model. The first rollout should not depend on this model.

## 3. State, audit trail, and undo

Add `AUTO_ACKNOWLEDGED` to `AgentInboxState`. The item remains a durable
`NOTICE`; auto-acknowledgement is a governance state transition, not deletion,
rejection, or approval. The state transitions are:

```text
PENDING --eligible auto-ack--> AUTO_ACKNOWLEDGED
AUTO_ACKNOWLEDGED --human undo--> PENDING
PENDING --human approve--> APPROVED
PENDING --human reject--> REJECTED
```

Every auto-acknowledged item must retain:

- the original notice payload and linked thread identifiers;
- the rule id and rule revision used for the decision;
- a reason code list, including `vendor_pitch`, `sender_untrusted`,
  `not_customer`, `not_reply`, and the cap value;
- the classifier name and version, or `rule-configured` for the first lane;
- the decision timestamp and UTC day;
- the customer-identity response and source, without copying the customer record;
- the undo actor, timestamp, and note when undo occurs.

Use the existing append-only agent action feed for the operator activity stream.
It already has one row per governance-relevant action, actor attribution,
message id, detail, and workspace fence. (`backend/prisma/schema.prisma:1499-1529`)
Add `AUTO_ACKNOWLEDGED` and `AUTO_ACKNOWLEDGED_UNDONE` action kinds, with the
agent-inbox item id and rule id included in structured detail.

Also add a dedicated append-only `AgentInboxAutoAckEvent` table for structured
queries and retention. It should contain workspace id, item id, rule id,
mailbox id, inbound message key, event kind, reason JSON, classification and
model versions, customer-guard result, actor id for undo, and created time. The
inbound message key must be a stable provider message id when available, with a
deterministic fallback of mailbox, thread, sender, and received time. A unique
decision key for `(workspaceId, ruleId, inboundMessageKey)` prevents watcher
polls from creating a second auto-ack decision. Undo does not refund the daily
cap and does not permit a second automatic decision for the same key.

Add a `MailRuleAutoAckUsage` table keyed by workspace, rule, and UTC day with an
atomic count. Claim a cap slot and transition the item in the same transaction.
If the claim fails, leave the item pending and emit a `cap_reached` audit event.
The recommended initial cap is 10 per rule per day, configurable from 1 through
50, with a hard service-side maximum of 50.

## 4. Data model changes

The migration should make these additive changes:

1. Add `autoAcknowledgeEnabled Boolean @default(false)`,
   `autoAcknowledgeClassification String?`, and
   `autoAcknowledgeDailyCap Int @default(10)` to `MailRule`. Require the
   classification to be `vendor_pitch` when enabled. Preserve the existing
   `match` and `actions` JSON contract.
2. Add `AUTO_ACKNOWLEDGED` to `AgentInboxState`.
3. Add immutable decision snapshot columns to `AgentInboxItem`, including
   `autoAckRuleId`, `autoAckReason Json?`, `autoAckClassifierVersion String?`,
   `autoAckAt DateTime?`, and `autoAckUndoneAt DateTime?`. Keep `reviewedByUcUid`
   null for the automatic action; the undo actor belongs in the audit event.
4. Add `AgentInboxAutoAckEvent` and `MailRuleAutoAckUsage` as described above,
   both workspace scoped and indexed for the rule, day, item, and event time.
5. Extend the inbound rule evaluation context with explicit provider and
   Customer-Ops facts: `isReplyToOurThread`, `customerStatus`,
   `customerContactId`, `customerStatusSource`, and `safetyDataVersion`.
   Missing facts must be represented as unknown, not false.

Do not store a copied customer profile or message body in the new tables. Keep a
thin customer reference and the decision facts needed to explain the result.

## 5. API changes

### Mail-rule REST API

Extend the existing create and patch request DTOs with an optional
`auto_acknowledge` object. The current DTOs expose only name, enabled, priority,
match, and actions. (`backend/src/mail-rules/mail-rules.controller.ts:22-38`)

```json
{
  "auto_acknowledge": {
    "enabled": true,
    "classification": "vendor_pitch",
    "daily_cap": 10,
    "support_mailbox": "support@majiks.studio"
  }
}
```

The response should return the setting, effective cap, current UTC-day usage,
and a validation warning when the rule is enabled but cannot satisfy the support
mailbox guard. Only a workspace member with existing rule-edit permission may
change it. Enabling it should require an explicit confirmation in the UI and
must never be accepted from an agent principal.

### Agent-inbox REST API

- Extend `GET /workspaces/:workspaceId/agent-inbox?state=` with
  `auto-acknowledged`. The response item includes the saved reason, rule
  classification, decision time, and undo availability.
- Add `POST /workspaces/:workspaceId/agent-inbox/:id/undo-auto-acknowledge`.
  Require a human workspace reviewer, verify the item is an
  `AUTO_ACKNOWLEDGED` notice, move it to `PENDING`, and append both audit
  records. Return the normal inbox view.
- Keep approve and reject behavior unchanged for pending notices. An
  auto-acknowledged item cannot be approved or rejected until it is undone.
- Keep the pending count limited to `PENDING`; the Auto-acknowledged filter gets
  its own count so automatic handling does not hide volume.

The MCP list-inbox contract should accept the new state and expose the same
reason snapshot. Add a human-only MCP undo action only if Aaron wants parity
with the REST surface; otherwise return a clear unsupported response rather
than allowing an agent to undo its own automated decision.

## 6. UI changes

### Rule editor

Add an unchecked "Auto-acknowledge vendor pitches" control under each mailbox
rule. When checked, show the fixed `vendor_pitch` classification, support-mailbox
guard, daily-cap input, and a concise explanation of every hard stop. Display
the setting as off when absent so existing rules preserve behavior.

Before save, require confirmation that automatic handling can skip Aaron's
approval queue only for notices that pass all predicates. Show a preview of the
rule conditions and a warning that customer status or reply history being
unknown blocks the action.

### Agent inbox

Add an Auto-acknowledged tab beside the existing Pending, Auto-sent, and History
tabs. Each card should show the sender, subject, mailbox, rule name, decision
time, classification, and a human-readable reason such as:

```text
Vendor pitch rule matched; sender is not trusted; no reply to our thread;
Customer-Ops found no existing customer; daily cap 3 of 10.
```

Keep Open thread available. Replace approve and dismiss controls with an Undo
auto-acknowledge button that returns the item to Pending after confirmation.
Show the original automatic event and the undo event in the card history.
Items with unknown or failed safety facts must remain in Pending with the
specific blocked reason visible to the reviewer.

## 7. Tests

Add backend unit and integration coverage for:

- default-off behavior for old and newly created rules;
- exact `vendor_pitch` classification and rejection of unknown classifications;
- every predicate independently blocking auto-acknowledge;
- trusted address and trusted domain opt-outs;
- existing customer, unknown customer, and Customer-Ops unavailable cases;
- reply-to-our-thread detection, missing history, and provider failure;
- attachment, forwarded, spam, malformed, and low-confidence cases;
- atomic per-rule daily cap under concurrent inbound delivery;
- duplicate watcher polls and stable inbound decision keys;
- reason snapshot contents, append-only audit events, and no copied customer data;
- undo authorization, state restoration to `PENDING`, no cap refund, and no
  second auto-acknowledge for the same inbound key;
- cross-workspace reads and writes for rules, notices, usage, events, and undo;
- REST and MCP state filtering, response shapes, and human-only enable and undo.

Add frontend tests for the off-by-default rule form, confirmation copy, reason
rendering, Auto-acknowledged filter, pending-count behavior, and undo success or
failure. Use fictional addresses and mocked Customer-Ops, provider, and local
classifier responses. No test may call a live host, paid API, mailbox, or
database.

## 8. Rollout

1. Ship the additive schema and API with the global feature gate off. Existing
   rules remain unchanged because the per-rule default is false.
2. Add a dry-run metric path that evaluates the predicates, records blocked
   reasons, and never changes item state. Run it against one rule for
   `support@majiks.studio` in Aaron's dogfood workspace.
3. Enable the real transition for that one rule only after the dry-run shows no
   customer or reply-history false positives. Start at a cap of 10 per day.
4. Review the Auto-acknowledged filter daily, including undo count, cap hits,
   unknown Customer-Ops results, blocked replies, and customer-guard blocks.
5. Expand to another rule only after Aaron accepts the reason vocabulary and the
   Customer-Ops contract. Keep the global gate available for immediate disable;
   disabling it stops new transitions and leaves prior events visible.

Rollback is a configuration change, not data deletion. If a bad decision is
found, undo the item to `PENDING`, preserve both audit events, and disable the
rule setting. Do not delete notices or audit rows.

## Open questions for Aaron

1. Is `support@majiks.studio` the exact first dogfood mailbox, and should the
   Customer-Ops existing-customer check be mandatory for every support alias?
2. Is a default cap of 10 auto-acknowledgements per rule per UTC day acceptable,
   with a hard maximum of 50?
3. Should undo be available to all current inbox reviewers, or restricted to
   workspace owners and admins?
