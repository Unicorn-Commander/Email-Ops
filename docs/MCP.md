# Email-Ops MCP server

Email-Ops exposes a **Model Context Protocol** server so Claude Code — and any
federating suite agent (e.g. Customer-Ops) — can read inboxes, triage threads,
manage the agent fleet, and stage/send mail **on the calling user's behalf**.
Every call runs *as that user*, inside their workspace, under the same
entitlement gate and Postgres RLS fences as the web UI. There is no separate
service identity and no way to reach a workspace you aren't a member of.

## Endpoint

```
https://email-ops.magicunicorn.dev/api/v1/mcp
```

- **Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`). The route accepts
  `POST`/`GET`/`DELETE` on `/api/v1/mcp`.
- **Stateless:** each request re-authenticates and mints a per-request server
  scoped to the caller; the client supplies its own session framing.
- Rate-limiting is skipped on this route (agent traffic), but auth + the
  workspace membership gate + the compose entitlement are always enforced.

## Authentication

The MCP endpoint is guarded by `JwtAuthGuard`. Send a **Bearer token** in the
`Authorization` header. Two token types are accepted:

- A **uchub Keycloak** access token (realm RS256, `aud=email-ops`) — the same
  identity the web app uses.
- An **`eo_pat_…` personal access token** (SUITE-IDENTITY §D9) — a long-lived
  token you mint for an agent/CLI. Recommended for Claude Code.

### Mint / revoke a PAT

PATs are managed under `/api/v1/auth/pats`, guarded so that **a PAT can never
mint, list, or revoke another PAT** (no self-perpetuating credential chain — a
PAT-authenticated call to these routes gets `403`). Authenticate these calls with
a real uchub login token:

```bash
# Mint (the plaintext token is returned exactly ONCE — store it now):
curl -sX POST https://email-ops.magicunicorn.dev/api/v1/auth/pats \
  -H "Authorization: Bearer <uchub-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"claude-code"}'
# -> { "id": "...", "name": "claude-code", "token": "eo_pat_...", "token_prefix": "eo_pat_...", "created_at": "..." }

# List your tokens (non-secret fields only):
curl -s https://email-ops.magicunicorn.dev/api/v1/auth/pats -H "Authorization: Bearer <uchub-jwt>"

# Revoke one (soft-revoke; 204):
curl -sX DELETE https://email-ops.magicunicorn.dev/api/v1/auth/pats/<id> -H "Authorization: Bearer <uchub-jwt>"
```

## Install into Claude Code

```bash
claude mcp add --transport http email-ops \
  https://email-ops.magicunicorn.dev/api/v1/mcp \
  --header "Authorization: Bearer eo_pat_..."
```

Verify with `claude mcp list`; the tools below should appear.

## Tools (34)

All data access runs through `EmailService`/the domain services inside the RLS
transaction. Reads are viewer-level; **`compose_email` / `approve_agent_inbox_item`
require both the `customer-ops` and `email-ops` entitlements** (a compose/send
gate re-derived server-side from the verified token).

**Foundation**
- `health`, `email_ops_health` — liveness + the workspace email-health snapshot.
- `list_my_workspaces` — the workspaces the caller belongs to (discovery).

**Mail (the EmailOpsPort contract — matches Customer-Ops verbatim)**
- `list_threads_with_contact(workspace_id, contact_id)` → `{ threads }`.
- `list_thread_messages(workspace_id, thread_id)` → `{ messages }` (previews).
- `compose_email(workspace_id, contact_id, to_address, subject, body, mode[send|draft], in_reply_to_thread_id?, external_source, external_ref)` →
  the message view. **Idempotent** on `(workspace_id, external_source, external_ref)`.
  `mode=send` queues delivery; `mode=draft` stages the agent inbox.

**Agent inbox (human-in-the-loop)**
- `list_agent_inbox(workspace_id, state?)` — the approval queue (pending default).
- `approve_agent_inbox_item(workspace_id, item_id, note?)` — approves **and sends**.
- `reject_agent_inbox_item(workspace_id, item_id, note?)` — never sends.

**Triage & sender policy**
- `set_disposition(workspace_id, thread_id, disposition)` — file a thread
  (Inbox/Archive/Spam/Trash). Agent-set dispositions feed the **Triaged** metric.
- `set_sender_policy(workspace_id, …)` — block/trust a sender (address or domain).

**Fleet & provisioning**
- `list_agents(workspace_id)` — the agent fleet + autonomy levels.
- `provision_agent(…)` · `provision_mailbox(…)` — create an agent / mailbox
  identity (policy-gated).

**Mail-engine admin (Apache James / sovereign engine)**
- `list_mail_domains` · `ensure_mail_domain` · `remove_mail_domain`
- `list_mail_accounts` · `set_mailbox_quota` · `remove_mailbox_engine`

**Connected-account cleaner (Gmail / Microsoft 365 via broker token)**
- `list_connected_accounts` · `get_inbox_stats` · `analyze_inbox`
- `plan_cleanup` · `clean_trash` · `clean_delete` · `organize_messages`
- `unsubscribe_sender` · `undo_batch`

**Cockpit UI control (agent-driven navigation)**
- `ui_navigate` · `ui_open_thread` · `ui_compose` · `ui_switch_space` · `ui_notify`

Run `list_my_workspaces` first to discover the `workspace_id` values you can
address, then scope every other call to one of them.

## Safety model

- **Tenant isolation:** every tool resolves the workspace through the membership
  gate and executes inside `withWorkspace` (RLS GUC + explicit `workspaceId`
  predicates). A foreign `workspace_id` resolves to no access.
- **Send gate:** composing or approving requires the dual `customer-ops` +
  `email-ops` entitlement, re-derived from the verified token.
- **PAT scope:** a PAT authenticates as its owner but cannot manage tokens
  (403 on `/auth/pats`); revocation is immediate (soft-revoke).
- **Human-in-the-loop:** `mode=draft` and L0/L1 agents stage into the agent
  inbox; nothing leaves until a human approves. Autonomous (L2) sends are
  recorded in the activity rail (see the in-app **Help**, `?` in the mail top
  bar, and the `agent-metrics` endpoint).
