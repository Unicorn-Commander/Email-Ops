# Agent tokens

An **agent token** is a credential you create in **Settings → Agent tokens** for an
assistant or automation that talks to Email-Ops on your behalf. It always starts
with `eo_pat_…`. Four things are worth knowing before you make one:

- **It is shown once.** Email-Ops keeps only a hash of the token, so the full
  value can never be displayed again. Copy it into your agent's configuration
  before you close the page. If you lose it, create a new token.
- **It is scoped.** A token carries only the permissions (scopes) and mailboxes
  you tick at creation.
- **It always expires.** There is no way to create a token that lives forever.
- **It cannot create other tokens.** Minting, listing, and revoking tokens only
  works while you are signed in with your own account. A stolen token cannot
  breed more tokens.

## How this differs from the "Connect your AI" sign-in

The **Connect your AI** card on the same page sets up a browser sign-in: your
assistant opens a sign-in window, you sign in as yourself, and it then acts with
your permissions and nothing more. That is the easiest option when the assistant
can open a browser.

An agent token is for the cases that cannot: a CLI, a server-side automation, or
a client with no sign-in window. You paste the token into the client instead of
signing in. A token is deliberately narrower than your sign-in — it only has the
scopes and mailboxes you chose, and it expires on its own.

## Scopes

Pick the fewest scopes the job needs. These are the choices in the form:

| Scope | In the app | What it can do | When to pick it |
| --- | --- | --- | --- |
| `mail:read` | Read mail | List threads and read messages. | The agent only reads or summarizes mail. Start here. |
| `mail:write` | Compose and change mail | Stage drafts and make mail changes. | The agent drafts messages for you to approve. |
| `agent-inbox:read` | Read the approval queue | See drafts waiting for you. | The agent should show you what is pending. |
| `agent-inbox:approve` | Approve the queue | Approve or reject drafts. Approving a send lets it leave. | Only if the agent may approve on your behalf. |
| `cleaner:run` | Run cleanup | Stage cleanup plans for your approval. | The agent tidies mailboxes (plans still wait for you). |
| `admin:provision` | Provision | Provision mailboxes and domains. | Setup automation only — this is admin-level reach. |
| `ui:control` | Drive the app | Open screens and prefill the composer. You still press Send. | The agent drives the app on your screen. |

Notes:

- The form starts with `mail:read` + `agent-inbox:read` checked — a reader, not
  a sender. That is a good default for a first token.
- `mail:write` alone does **not** put mail on the wire: sending through the
  agent compose path also requires `agent-inbox:approve`.

## Mailbox access

The default is **All current mailboxes**, which means the token can touch every
mailbox you own — including any you add later. For most agents, pick **specific
mailboxes** instead: the token can only ever see the ones you ticked, and the
selected list is re-checked against the mailboxes you still own on every request,
so removing access takes effect immediately.

## Expiry

Every token expires. The default lifetime is **90 days**; the maximum is
**365 days**. A never-expiring token cannot be created at all. Choose the
shortest lifetime the job allows — an agent you re-visit monthly does not need
a yearly token.

## Rotating a token

There is no "edit" for a token; you replace it:

1. **Create** a new token with the scopes and mailboxes you want now.
2. **Swap** the value in the agent's configuration and confirm it works.
3. **Revoke** the old one. Anything still using it loses access immediately.

## If a token leaks

**Revoke it now.** In your token list, press **Revoke** next to the token and
confirm. The agent loses access immediately; nothing else in your account
changes. Then create a fresh token with the same (or fewer) scopes and update
the agent. Because the plaintext was never stored and a token can never mint
other tokens, revoking is the whole cleanup.
