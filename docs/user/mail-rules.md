# Mail rules (user guide)

A mail rule is a small automation you attach to one mailbox. When new mail
arrives in that mailbox, Email-Ops checks the message against the rule's match.
If it matches, Email-Ops runs the rule's actions (file it, archive it, mark it
read, notify you, or forward a copy). Rules run on their own, right after the
message lands, and never touch mail that arrived before you made the rule.
<!-- backend/src/mail-rules/mail-rules.service.ts:197-217 -->

Rules are per mailbox. Each mailbox has its own list of rules, and a rule only
ever acts on mail in the mailbox it belongs to.
<!-- backend/prisma/schema.prisma:1134-1155 -->

## What a rule holds

Every rule has these parts:

- **Name.** A label you choose, so you can recognise it in the list.
- **Enabled.** A switch. A disabled rule is kept but skipped, so you can pause a
  rule without deleting it.
- **Priority.** A number that sets the order rules run in. Lower runs first.
- **Match.** The conditions a message must meet for the rule to fire.
- **Actions.** What to do when the rule fires.
- **Hit count.** How many times the rule has fired. This is only a counter for
  your information; nothing depends on it.

<!-- backend/prisma/schema.prisma:1138-1144; backend/src/mail-rules/mail-rules.types.ts:33-45 -->

A mailbox can hold up to 100 rules.
<!-- backend/src/mail-rules/mail-rules.service.ts:37,110-113 -->

## What a match can check

A match is built from simple conditions. Each condition picks one part of the
message, one comparison, and one value to compare against.

Parts you can match on:

- **From.** The sender address.
- **To.** The real recipients on the message. If the recipient header is
  unknown, a To condition matches nothing rather than guessing.
- **Subject.** The subject line.
- **From domain.** The domain part of the sender address (after the `@`).

Comparisons you can use:

- **is** (equals)
- **contains**
- **starts with**
- **ends with**

All comparisons ignore capitalisation, so `Invoice` and `invoice` are the same.
<!-- backend/src/mail-rules/rule-engine.ts:27-34,178-231 -->

### Combining conditions

You can put several conditions together in two ways:

- **All** (AND): every condition must hold.
- **Any** (OR): at least one condition must hold.

You can group them, for example "all of these, where each one is any of these"
(AND of ORs). New rules allow at most 5 groups and at most 10 conditions per
group.

A rule with no real conditions never fires by accident. An empty match, or a
malformed one, matches nothing, so a half-built rule cannot sweep your whole
inbox.
<!-- backend/src/mail-rules/rule-engine.ts:36-56,141-168; backend/src/mail-rules/mail-rules.types.ts:4-30; backend/src/mail-rules/mail-rules.service.ts:45-46,731-757 -->

## How rules are evaluated

When a message arrives, Email-Ops looks at that mailbox's enabled rules in
priority order, lowest number first. For each rule, in turn:

1. If the rule is disabled, it is skipped.
2. If the message does not match, it is skipped.
3. If it matches, the rule's actions run in order.
4. If those actions include **STOP**, evaluation stops. No lower rule runs for
   this message.

Rules without a STOP do not block each other, so several rules can act on the
same message. When more than one rule moves or files the message, the last one
to run wins, the same as if you had clicked both by hand.

New rules you create are added at the end of the order automatically.
<!-- backend/src/mail-rules/rule-engine.ts:81-113; backend/src/mail-rules/mail-rules.service.ts:115-121,197-203,261 -->

## The actions

- **Move to folder.** Files the message into a folder you pick. Only on your
  own Email-Ops (Stalwart) mailboxes; Gmail and Microsoft mailboxes have no
  folder model here, so this action is refused for them.
- **Archive.** Moves the message out of the inbox to the archive.
- **Trash.** Moves the message to the trash.
- **Mark read.** Marks the thread as read.
- **Notify.** Puts a card in your approval queue (a `Notice`) so a person sees
  the message. It never sends mail. You can add a short note (up to 200
  characters) that shows on the card.
- **Forward copy.** Sends a copy of the message to one address inside your
  workspace (a mailbox, connected account, or a mail domain you have bound).
  Only on your own Email-Ops (Stalwart) mailboxes. It will not forward mail that
  is already a forwarded copy, or mail addressed to the same place it would
  forward to, so it cannot loop.
- **Stop.** Ends rule evaluation for this message. It does nothing on its own,
  so a rule must also have at least one real action.

A rule must have at least one action, and cannot be only a Stop. The **Label**
action is not supported yet.
<!-- backend/src/mail-rules/rule-engine.ts:12-25; backend/src/mail-rules/mail-rules.service.ts:100-107,349-408,410-427,619-659,762-846; docs/ops/agent-inbox-states.md:195-200 -->

## Where to manage rules

Rules live in the Mail view, on the mailbox you pick:

1. Open **Mail** and select the mailbox in the left sidebar.
2. Choose **Rules** in that mailbox's sidebar (the funnel icon). You can also
   open the command palette and run **Rules**.
3. The Rules dialog lists your rules in priority order. Each row has an on/off
   switch, an Edit button, a Delete button, and, once it has fired, an "Applied
   N times" line.
4. Choose **New rule** to add one, or **Edit** to change one.

The dialog title says which mailbox the rules act on.
<!-- frontend/app/mail/page.tsx:1083-1091,1692-1702,2147-2160; frontend/components/mail/RulesDialog.tsx:425,697,755-780,1107-1112 -->

## Two examples

Both use fictional `example.com` senders.

### Example 1: file receipts and mark them read

Match (all of):

- From domain **is** `billing.example.com`
- Subject **contains** `receipt`

Actions:

- Move to folder `Receipts`
- Mark read

So a message from `billing.example.com` with "receipt" in the subject is filed
into the Receipts folder and marked read as it arrives.
<!-- backend/src/mail-rules/rule-engine.ts:27-34,389-402 -->

### Example 2: tell me when the domain team writes

Match (all of):

- From **is** `domains@example.com`

Actions:

- Notify, with the note `Renewal notice`

So a message from `domains@example.com` puts a Notice card in your approval
queue with your note on it, and leaves the message where it is.
<!-- backend/src/mail-rules/mail-rules.service.ts:359-368,619-659; docs/ops/agent-inbox-states.md:195-200 -->

## Related

- [Agent-inbox item lifecycle (operator)](../ops/agent-inbox-states.md)
- [Connect your own Gmail or Microsoft 365 mailbox](../connect-your-mailbox.md)
