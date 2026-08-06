# Email-Ops MCP Developer Documentation

Email-Ops exposes a **Model Context Protocol (MCP)** server so agents (e.g.
Claude Code, Customer-Ops) can read inboxes, triage threads, manage the agent
fleet, and stage/send mail **on the calling user's behalf**. Every call runs *as
that user*, inside their workspace, under the same entitlement gate and Postgres
RLS fences as the web UI. There is no separate service identity and no way to
reach a workspace you aren't a member of.

## Endpoint

```
https://email-ops.magicunicorn.dev/api/v1/mcp
```

- **Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`). The route accepts
  `POST`/`GET`/`DELETE` on `/api/v1/mcp`.
- **Stateless:** each request re-authenticates and mints a per-request server
  scoped to the caller; the client supplies its own session framing.
- Rate-limiting **applies** to this route (the global throttler), alongside auth,
  the workspace membership gate, and the compose entitlement.

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

## Quickstart

### 1. List Available Tools

To discover the tool surface, call `tools/list`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### 2. Call a Tool

To execute a tool, call `tools/call`. For example, to list your workspaces:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "list_my_workspaces",
    "arguments": {}
  }
}
```

## Tool Reference

All data access runs through `EmailService`/the domain services inside the RLS
transaction. Reads are viewer-level; **`compose_email` / `approve_agent_inbox_item`
require both the `customer-ops` and `email-ops` entitlements** (a compose/send
gate re-derived server-side from the verified token).

### Foundation

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `health` | Liveness + configuration check | None | Yes |
| `email_ops_health` | Workspace email-health snapshot | `workspace_id?` | Yes |
| `list_my_workspaces` | List caller's active workspaces | None | Yes |

### Mail Read Plane

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `list_threads` | List threads in a mailbox folder | `workspace_id?`, `mailbox_id?`, `folder?`, `q?`, `limit?`, `offset?` | Yes |
| `get_thread` | Get full thread messages with bodies | `workspace_id?`, `thread_id`, `mailbox_id?` | Yes |
| `search_mail` | Full-text search over mailboxes | `workspace_id?`, `mailbox_id?`, `q`, `folder?`, `limit?`, `offset?` | Yes |
| `set_read` | Mark thread read/unread | `workspace_id?`, `thread_id`, `read`, `mailbox_id?` | No |
| `bulk_disposition` | Bulk-triage threads into a folder | `workspace_id?`, `thread_ids[]`, `disposition` | No |

### EmailOpsPort Contract (Customer-Ops)

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `list_threads_with_contact` | List threads with a contact | `workspace_id?`, `contact_id` | Yes |
| `list_thread_messages` | List thread messages (previews) | `workspace_id?`, `thread_id` | Yes |
| `compose_email` | Compose outbound email | `workspace_id?`, `contact_id?`, `to_address`, `subject`, `body`, `mode?`, `in_reply_to_thread_id?`, `external_source`, `external_ref` | No |

### Agent Inbox (Human-in-the-Loop)

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `list_agent_inbox` | List agent-inbox queue | `workspace_id?`, `state?` | Yes |
| `approve_agent_inbox_item` | Approve draft (sends it) | `workspace_id?`, `item_id`, `note?` | No |
| `reject_agent_inbox_item` | Reject draft (never sends) | `workspace_id?`, `item_id`, `note?` | No |

### Triage & Sender Policy

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `set_disposition` | Move thread to folder | `workspace_id?`, `thread_id`, `disposition` | No |
| `set_sender_policy` | Block/trust a sender | `workspace_id?`, `scope?`, `pattern`, `kind`, `reason?` | No |

### Fleet & Provisioning

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `list_agents` | List agent fleet | `workspace_id?` | Yes |
| `provision_mailbox` | Create a mailbox | `workspace_id?`, `email_address`, `display_name?`, `owner_kind?`, `owner_key?` | No |
| `provision_agent` | Register a new agent | `workspace_id?`, `key`, `display_name`, `description?`, `autonomy_level?`, `tier?`, `manager_agent_key?`, `mailbox_account_id?` | No |

### Mail-Engine Admin (Apache James)

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `list_mail_domains` | List served domains | `workspace_id?` | Yes |
| `list_mail_accounts` | List hosted accounts | `workspace_id?` | Yes |
| `ensure_mail_domain` | Add domain to engine | `workspace_id?`, `domain` | No |
| `remove_mail_domain` | Remove domain from engine | `workspace_id?`, `domain` | No |
| `set_mailbox_quota` | Set storage quota | `workspace_id?`, `address`, `quota_bytes` | No |
| `remove_mailbox_engine` | Remove engine account | `workspace_id?`, `address` | No |

### Connected-Account Cleaner (Gmail / Microsoft)

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `list_connected_accounts` | List linked accounts | `workspace_id?` | Yes |
| `get_inbox_stats` | Get inbox stats | `workspace_id?`, `provider` | Yes |
| `analyze_inbox` | Run inbox analysis | `workspace_id?`, `provider` | Yes |
| `plan_cleanup` | Dry-run cleanup plan | `workspace_id?`, `provider`, `criteria?` | Yes |
| `clean_trash` | Stage trash cleanup | `workspace_id?`, `provider`, `criteria?` | No |
| `clean_delete` | Stage delete cleanup | `workspace_id?`, `provider`, `criteria?` | No |
| `organize_messages` | Stage organize/archive | `workspace_id?`, `provider`, `criteria?` | No |
| `unsubscribe_sender` | Stage unsubscribe batch | `workspace_id?`, `provider`, `sender_group[]` | No |
| `undo_batch` | Undo cleanup batch | `workspace_id?`, `provider`, `batch_id` | No |

### Cockpit UI Control

| Tool Name | Purpose | Key Parameters | Read-Only |
| :--- | :--- | :--- | :--- |
| `ui_navigate` | Navigate cockpit route | `workspace_id?`, `path` | No |
| `ui_open_thread` | Open thread in cockpit | `workspace_id?`, `mailbox_id?`, `thread_id` | No |
| `ui_compose` | Pre-fill composer | `workspace_id?`, `to?`, `subject?`, `body?`, `thread_id?` | No |
| `ui_switch_space` | Switch active Space | `workspace_id?`, `space_id` | No |
| `ui_notify` | Show toast notification | `workspace_id?`, `title`, `body?`, `tone?` | No |

Run `list_my_workspaces` first to discover the `workspace_id` values you can
address, then scope every other call to one of them.

## Safety Model

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
