<div align="center">
  <p>
    <img src="frontend/public/landing-assets/email-ops-unicorn.png" width="112" alt="Email-Ops unicorn mascot">
  </p>
  <h1>Email-Ops</h1>
  <p><strong>Agent-drafted email with a human approval inbox.</strong></p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-2ea44f" alt="License: Apache-2.0"></a>
    <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/release-0.6.0-7c3aed" alt="Release: 0.6.0"></a>
    <img src="https://img.shields.io/badge/stack-NestJS%2010%20%2B%20Next.js%2015-111827" alt="Stack: NestJS 10 and Next.js 15">
    <img src="https://img.shields.io/badge/deployment-Docker%20self--hosted-2496ed" alt="Docker self-hosted">
    <img src="https://img.shields.io/badge/agents-MCP--native-f59e0b" alt="MCP-native agent integration">
  </p>
  <p>
    <a href="#quick-start">Quick start</a> ·
    <a href="#highlights">Features</a> ·
    <a href="#built-for-agents">Agents</a> ·
    <a href="#architecture">Architecture</a> ·
    <a href="#part-of-unicorn-commander">Suite</a>
  </p>
</div>

<p align="center">
  <img src="docs/screenshots/mail.webp" width="1200" alt="Email-Ops unified inbox showing workspace mailboxes, threads, and agent activity">
</p>

## What is Email-Ops?

Email-Ops is the mailbox, thread, and agent-inbox surface for the Unicorn Commander suite. It gives teams a unified view of their mail, lets agents triage and draft work, and puts outbound decisions in a human approval queue. Agents prepare mail. At the default autonomy level, internal mail can send on its own and any external recipient waits for approval. Unattended sends are written to the audit log. It is self-hostable, workspace-scoped, and connects to the rest of the suite through shared identity and an authenticated MCP contract rather than copying mail into every cockpit.

## Highlights

- **Unified inbox:** Search, read, reply, reply-all, forward, flag, and move threads across registered mailboxes from one command-center view. Moving a thread asks that mailbox's engine to move it. For sovereign mail, an overlay is also recorded so a refetch does not put the thread back. If the engine move fails for a connected Gmail or Microsoft thread, no overlay is written. With more than one mailbox, All inboxes merges them newest-first.
- **Assistant actions:** The streaming assistant can summarize and triage mail, stage threaded draft replies, and prepare cleanup batches. A native unsubscribe is staged only when the selected message advertises an RFC 2369 / RFC 8058 one-click or mailto target. Threads without one are reported and skipped. A staged request waits for approval.
- **Human approval inbox:** Agent-drafted email, cleanup batches, and mail-rule notices land in a review queue with approve/reject decisions and audit context, so automation stays accountable.
- **Policy-controlled autonomy:** Each agent is L0, L1, or L2. New agents default to L1. L0 stages every send. L1 sends internal mail on its own and stages anything with an external recipient. L2 may also send a routine external reply when `AGENT_AUTONOMOUS_SEND_ENABLED` is not `false`: an in-thread reply to an inbound message, every external recipient already trusted, no attachments, and at most five external recipients. A per-agent rule can still hold every external send. Those sends are audited. Agent-initiated mail from a human or shared mailbox always waits for approval. Pause one agent, or the whole fleet, when the situation changes.
- **Managed sending identities:** Register human, agent, or shared mailboxes and bind agents to the identities they are allowed to use; provisioning policy controls who may create or change them.
- **Review-only insights:** Analyze connected Gmail or Microsoft 365 inbox metadata and headers for patterns, unread volume, senders, and recommendations; the UI keeps suggested cleanup behind a review gate.
- **Suite tenancy:** Workspace membership, server-side authorization, Prisma persistence, and row-level isolation give web users and agents the same boundary.

### Data boundaries

| Email-Ops records | Email-Ops federates |
|---|---|
| Workspace mailboxes, the outbound messages it creates, approval decisions, agent identities, and policy state | Mailbox contents and delivery through the selected engine; Postmark for the transactional lane when that token is set; Gmail and Microsoft 365 for connected mailboxes |

The app follows a “federate the engine” boundary: a suite cockpit can address Email-Ops by `workspace_id` over MCP without running a second mail server or copying a thread into its own database.

## Feature tour

### Unified inbox

<p align="center">
  <img src="docs/screenshots/mail.webp" width="1000" alt="Unified inbox with mailbox picker, thread list, reader, and agent activity rail">
</p>

The `/mail` surface is a five-zone command center: icon navigation, accounts and folders, the conversation list, the reader, and the agent-activity rail. It supports search, HTML mail in a sandboxed `srcdoc` iframe, attachments, bulk actions, keyboard shortcuts, and compose with reply, reply-all, and forward. Pop-out reading opens over the page or ejects the thread into its own window. All inboxes fans out across readable mailboxes — at most five reads at once, each capped at 8 seconds — and merges them newest-first. The activity rail reports server-computed counts from `GET /api/v1/workspaces/:id/agent-metrics` (`triaged`, `sent`, and `awaiting`; `window=7d` is the usual lookback).

### Agent approvals

<p align="center">
  <img src="docs/screenshots/approvals.webp" width="1000" alt="Agent-drafted mail waiting for a human to approve and send">
</p>

The approval inbox shows the exact draft or staged cleanup action before execution. A reviewer can inspect it, approve and send or run it, reject it, and leave an audit note.

### Mailboxes and sending identities

<p align="center">
  <img src="docs/screenshots/mailboxes.webp" width="1000" alt="Mailboxes and sending identities managed in Email-Ops">
</p>

Mailboxes are first-class workspace records for people, agents, and shared addresses. The provisioning policy and mailbox bindings make the sending identity explicit instead of relying on a silent default.

### Agent fleet and permissions

The Agents view makes each agent’s mailbox, autonomy level, active state, and pending work visible. The pause controls and send-path policy are designed to be understandable before an agent acts.

### Insights

<p align="center">
  <img src="docs/screenshots/insights.webp" width="1000" alt="Email-Ops review-only inbox insights and recommendations">
</p>

Insights provide read-only mailbox analysis for connected accounts. If the AI layer is unavailable, the service keeps the statistical view and does not silently turn recommendations into actions.

The `?` button in the mail top bar, and the `?` key, open the shortcut dialog. The `/help` page is the longer manual for approval, autonomy, cleanup, integrations, and keyboard shortcuts.

## Built for agents

Email-Ops exposes a stateless MCP Streamable HTTP endpoint at `/api/v1/mcp`. Clients use `POST`, `GET`, or `DELETE` with a Bearer credential: a hosted Keycloak access token, a self-host local session JWT, or a scoped personal access token. Each request is handled as the authenticated caller inside the caller’s workspace membership and database isolation boundary.

Trusted suite-agent JWT federation can be enabled through the issuer and audience settings in Configuration; it still resolves to a workspace-scoped caller before a tool runs.

The server registers **68 MCP tools** at this commit. The most useful starting points are:

- Read mail with `list_threads`, `get_thread`, and `search_mail`.
- Triage with `set_disposition`, `set_sender_policy`, and `bulk_disposition`.
- Compose through `compose_email`. `mode=draft` stages the agent inbox. `mode=send` queues the mailbox's lane: Apache James when `MAIL_ENGINE=james`, otherwise the Stalwart adapter. A transactional mailbox uses Postmark when `POSTMARK_SERVER_TOKEN` is set, except a James send that carries attachments, which goes out through JMAP. A connected Gmail or Microsoft mailbox uses that provider. Autonomy policy can downgrade the send to a draft.
- Work the human gate with `list_agent_inbox`, `approve_agent_inbox_item`, and `reject_agent_inbox_item`.
- Inspect and control the fleet with `list_agents`, `pause_agent`, and `resume_agent`.
- Federate the UI with `ui_navigate`, `ui_open_thread`, `ui_compose`, `ui_switch_space`, and `ui_notify`.

The cross-app EmailOpsPort tools are `list_threads_with_contact`, `list_thread_messages`, and `compose_email`. Results include MCP `structuredContent`. `compose_email` is idempotent on `(workspace_id, external_source, external_ref)`: a repeat returns the existing message and does not queue a second send. Reads are viewer-level inside the caller's workspace. Sending or drafting requires the `email-ops` entitlement; a compose with `external_source=customer-ops` also requires `customer-ops`. `UC_ENTITLEMENT_MODE=open` allows the compose and logs a warning. Any other value, including the unset default `enforce`, checks the claim. Approving an email draft re-checks `email-ops`. A NOTICE acknowledgement does not send. Cleanup approval uses the cleaner gate, which also requires `email-ops`.

The agent hook implemented here is MCP federation plus the `ui_*` command surface. The repository also publishes an MCP discovery manifest so a suite coordinator can learn the endpoint and advertised tool catalog without receiving a user credential.

### Connect a client

Replace the angle-bracket placeholders with the host and PAT you deliberately configured for the target workspace:

```bash
claude mcp add --transport http email-ops \
  https://<email-ops-host>/api/v1/mcp \
  --header "Authorization: Bearer <eo_pat_token>"
```

Minted personal access tokens use the `eo_pat_` prefix. `scopes` is required. Omitting `expires_in_days` keeps the 90-day default, and 365 is the maximum. A PAT cannot mint, list, or revoke another PAT.

See [docs/MCP.md](docs/MCP.md) for token minting, PAT scopes, the EmailOpsPort contract, and the complete tool reference.

## Quick start

### Docker self-host

This profile starts PostgreSQL 16, a one-shot role bootstrap, the NestJS API, and the frontend. It deliberately leaves hosted SSO, `MAIL_ENGINE`, Postmark, and the optional Cleaner Engine unconfigured, so the local approval and tenancy surfaces can be explored without inventing provider credentials. The example sets `UC_ENTITLEMENT_MODE=open`, so a missing SKU is allowed and a warning is logged. With the engine variables unset, mailbox reads return empty and sends are recorded as failed; the agent inbox still works.

Requirements: Docker with Compose, `curl`, and `openssl`. The PAT example also uses `jq`.

```bash
git clone https://github.com/Unicorn-Commander/Email-Ops.git
cd Email-Ops
cp .env.selfhost.example .env.selfhost

export POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export APP_DB_PASSWORD="$(openssl rand -hex 24)"
export JWT_SECRET="$(openssl rand -hex 32)"
export BOOTSTRAP_ADMIN_EMAIL=admin@example.test
# At least 12 characters. The loopback example keeps AUTH_COOKIE_SECURE=false;
# set it true only when the browser origin is HTTPS.
export BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 24)"

docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
curl -fsS http://127.0.0.1:3231/api/v1/health/ready
```

Open `http://127.0.0.1:3000` and choose Sign in. That landing link continues to `/auth/login`, which shows the local admin form when bootstrap credentials are configured. Sign in with the bootstrap email and password held in your shell. To create a least-privilege MCP credential after logging in, mint it through the local API; the plaintext is returned once, so store it in your client rather than committing it:

```bash
export EMAIL_OPS_ADMIN_JWT="$({
  curl -fsS -X POST http://127.0.0.1:3231/api/v1/auth/local/login \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${BOOTSTRAP_ADMIN_EMAIL}\",\"password\":\"${BOOTSTRAP_ADMIN_PASSWORD}\"}"
} | jq -er '.access_token')"

curl -fsS -X POST http://127.0.0.1:3231/api/v1/auth/pats \
  -H "Authorization: Bearer ${EMAIL_OPS_ADMIN_JWT}" \
  -H 'Content-Type: application/json' \
  -d '{"name":"selfhost-agent","scopes":["mail:read"]}'

unset EMAIL_OPS_ADMIN_JWT BOOTSTRAP_ADMIN_PASSWORD JWT_SECRET POSTGRES_PASSWORD APP_DB_PASSWORD
```

### Run from source

Use the Compose PostgreSQL service, then run the API and frontend from their own directories. Start with the environment setup above, or replace the example values in `.env.selfhost` before starting the database:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d \
  email-ops-postgres email-ops-db-bootstrap

cp backend/.env.example backend/.env
```

`backend/.env.example` still describes an older tenancy-off layout and contains hosted SSO values. Before `npm run start:dev`, point the runtime at the loopback database and clear those hosted values. `npm run prisma:deploy` reads `DATABASE_URL` only, so the migration command below uses the admin role for that one process. The API itself should keep the `email_ops_app` URL in `backend/.env`:

```bash
# DATABASE_URL=postgresql://email_ops_app:<APP_DB_PASSWORD>@127.0.0.1:55444/emailops?schema=public
# ADMIN_DATABASE_URL=postgresql://email_ops_admin:<POSTGRES_PASSWORD>@127.0.0.1:55444/emailops?schema=public
# JWT_SECRET=<JWT_SECRET>
# EMAIL_OPS_TENANCY_ENABLED=true
# BOOTSTRAP_ADMIN_EMAIL=admin@example.test
# BOOTSTRAP_ADMIN_PASSWORD=<BOOTSTRAP_ADMIN_PASSWORD>
# CORS_ORIGIN=http://127.0.0.1:3000
# FRONTEND_URL=http://127.0.0.1:3000
# AUTH_COOKIE_SECURE=false
# KEYCLOAK_URL=
# BRIGADE_TRUSTED_ISSUERS=
# EMAIL_OPS_ACCESS_LIST=
```

`EMAIL_OPS_TENANCY_ENABLED` defaults on for the membership gate when it is unset. Setting it `false` turns that gate into a no-op and treats every caller as OWNER. A `NODE_ENV=production` process refuses to boot in that state. `PrismaService` requires `ADMIN_DATABASE_URL` only when the variable is explicitly `true`, `1`, `yes`, or `on`. The block above sets `true`, so set the admin URL too. Keep `DEFAULT_WORKSPACE_ID` aligned with `.env.selfhost`.

```bash
cd backend
npm ci
env DATABASE_URL="postgresql://email_ops_admin:${POSTGRES_PASSWORD}@127.0.0.1:55444/emailops?schema=public" \
  npm run prisma:deploy
npm run start:dev
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

For local browser development, leave `NEXT_PUBLIC_API_URL` unset so the Next.js rewrite sends `/api/v1` requests to the local API. A live mail engine, connected-account provider, or Cleaner Engine is optional; configure those only when you are ready to exercise that integration.

## Configuration

The Docker profile uses [`.env.selfhost.example`](.env.selfhost.example). Source and optional-service templates live in [`backend/.env.example`](backend/.env.example), [`frontend/.env.example`](frontend/.env.example), and [`cleaner-engine/.env.example`](cleaner-engine/.env.example). The table names the important knobs without reproducing credential values.

| Variable | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL administrator password used by the self-host database container. |
| `APP_DB_PASSWORD` | Password assigned to the runtime database role by the self-host bootstrap service. |
| `DATABASE_URL` | Prisma runtime connection. The self-host API uses the `email_ops_app` role. |
| `ADMIN_DATABASE_URL` | Privileged connection for the container entrypoint's migrations and for cross-tenant system resolvers. `PrismaService` requires it when `EMAIL_OPS_TENANCY_ENABLED` is explicitly true. |
| `PORT`, `API_PREFIX` | Backend listen port (default `3231`) and API route prefix (default `api/v1`). |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Signing secret and lifetime for local session JWTs. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | Self-host local-login bootstrap identity. The password must be at least 12 characters. |
| `CORS_ORIGIN`, `FRONTEND_URL`, `AUTH_COOKIE_SECURE` | Browser origin, redirect target, and session-cookie `Secure` flag. When `AUTH_COOKIE_SECURE` is unset, the cookie is `Secure` only if `FRONTEND_URL` starts with `https://`. |
| `EMAIL_OPS_PUBLIC_BASE_URL` | Origin used for absolute URLs embedded in outbound mail, including agent avatars. |
| `EMAIL_OPS_TENANCY_ENABLED`, `DEFAULT_WORKSPACE_ID`, `UC_ENTITLEMENT_MODE` | Workspace tenancy (defaults on), the bootstrap workspace id, and the entitlement gate. `open` allows a missing SKU and logs a warning; anything else enforces. |
| `KEYCLOAK_*`, `BRIGADE_TRUSTED_ISSUERS`, `BRIGADE_EXPECTED_AUDIENCE` | Hosted SSO and trusted suite-agent JWT federation. Blank issuers disable that branch. The expected audience is `email-ops`. |
| `MAIL_ENGINE`, `JAMES_*`, `STALWART_*` | `james` selects Apache James (`JAMES_JMAP_URL`). Unset or `stalwart` selects the Stalwart adapter (`STALWART_JMAP_URL` or `STALWART_IMAP_HOST`). Mailbox reads stay empty until that URL or host is set. A transactional send can still use Postmark when only `POSTMARK_SERVER_TOKEN` is set. |
| `POSTMARK_SERVER_TOKEN` | Transactional lane for the bound engine. A mailbox with `postmark_lane=false` never uses it. On James, attachment sends go out through JMAP even when Postmark is set. On the Stalwart adapter, inline attachment bytes can ride the Postmark call. The From address is the mailbox, not a separate Postmark sender variable. |
| `CLEANER_ENGINE_URL`, `CLEANER_ENGINE_TOKEN`, `CLEANER_ENGINE_TIMEOUT_MS` | Optional connected-account analysis and cleanup service. |
| `CONNECTED_ACCOUNT_ENC_KEY` | Encryption key for linked-provider credentials at rest. |
| `EMAIL_WEBHOOKS_ENABLED`, `POSTMARK_WEBHOOK_SECRET` | Fail-closed Postmark engagement webhook receiver settings. |
| `INBOUND_WATCHER_ENABLED`, `AGENT_REPLY_RUNTIME_ENABLED` | Inbound JMAP polling and the agent-reply drafter. Both default off. The reply runtime stages drafts; it does not send. |
| `NEXT_PUBLIC_API_URL` | Frontend API base URL when the browser should not use the local Next.js rewrite. |

## Architecture

```mermaid
flowchart LR
    Human["Human in browser"] --> UI["Next.js frontend"]
    Agent["MCP client or suite agent"] -->|"Bearer auth · Streamable HTTP"| API["NestJS API"]
    UI -->|"/api/v1"| API
    Identity["Keycloak SSO or local bootstrap auth"] --> API
    API -->|"Prisma + workspace membership + RLS"| DB[("PostgreSQL 16")]
    API --> Providers["Mail/provider adapters"]
    Providers --> James["Apache James JMAP (MAIL_ENGINE=james)"]
    Providers --> Stalwart["Stalwart adapter (default if unset)"]
    Providers --> Gmail["Gmail"]
    Providers --> Microsoft["Microsoft 365"]
    Providers --> Postmark["Postmark transactional lane"]
    API -->|"read-only analysis and staged cleanup"| Cleaner["Cleaner Engine · FastAPI"]
    Cleaner --> Gmail
    Cleaner --> Microsoft
```

`MAIL_ENGINE=james` binds the mail port to `JamesClient` (JMAP). Leaving `MAIL_ENGINE` unset, which is what the self-host Compose file does, binds `StalwartClient`. The directory is still `backend/src/stalwart/`. A successful James send stores `mailboxIds` and moves the submitted message to Sent. On that client, a plain transactional send uses Postmark when `POSTMARK_SERVER_TOKEN` is set, and James submission otherwise. The Stalwart adapter uses Postmark for a transactional send when the token is set, and its own submission otherwise.

Workspace rows are fenced by membership plus Postgres row-level security. `infrastructure/database/init/01-init.sql` creates four roles: `email_ops_owner` (BYPASSRLS, not a login), `email_ops_app` (NOBYPASSRLS, the runtime login), `email_ops_audit`, and `email_ops_ro`. The fence is live when tenancy is on and `DATABASE_URL` uses `email_ops_app`. `PrismaService.withWorkspace()` sets the workspace GUC for that transaction.

The main components are:

- `frontend/` — the Next.js cockpit for mail, approvals, agents, mailboxes, and insights.
- `backend/` — the NestJS API, authentication, workspace authorization, mail domain logic, approval queue, provider routing, and MCP server.
- `backend/prisma/` — the PostgreSQL schema and migrations for workspace-scoped records and policy state.
- `cleaner-engine/` — an optional FastAPI service for connected Gmail and Microsoft 365 analysis and staged cleanup. Insights read headers and metadata. Suggested cleanup stays behind approval.
- `docker-compose.selfhost.yml` and `infrastructure/database/init/` — the local container profile and database bootstrap.

## Part of Unicorn Commander

| App | What it does |
|---|---|
| [Unicorn Commander](https://github.com/Unicorn-Commander/Unicorn-Commander) | Self-hosted infrastructure and multi-agent orchestration |
| [Unicorn Stable](https://github.com/Unicorn-Commander/Unicorn-Stable) | Humans and agents in the same room |
| [Accounting-Ops](https://github.com/Unicorn-Commander/Accounting-Ops) | Agent-native accounting and books |
| [Contact-Ops](https://github.com/Unicorn-Commander/Contact-Ops) | Shared contact and identity layer |
| [Customer-Ops](https://github.com/Unicorn-Commander/Customer-Ops) | Customer relationship and pipeline layer |
| [**Email-Ops**](https://github.com/Unicorn-Commander/Email-Ops) | **Agent-drafted email with a human approval inbox** |
| [Project-Ops](https://github.com/Unicorn-Commander/Project-Ops) | Projects and tasks, with status and context |
| [Meeting-Ops](https://github.com/Unicorn-Commander/Meeting-Ops) | In-browser recording, transcription, and meeting search |

Email-Ops connects to the suite through shared workspace identity and its authenticated MCP contract, so Customer-Ops and other suite agents can work with mail inside the caller’s permitted workspace.

## Development

The repository’s [Forgejo-compatible CI workflow](.forgejo/workflows/ci.yml) exercises the backend, Cleaner Engine, and frontend separately. The corresponding local commands are:

Backend:

```bash
cd backend
npm ci
npm run lint
npm run typecheck
npm run test:unit -- --maxWorkers=4
npm run test:integration -- --maxWorkers=2  # requires a migrated PostgreSQL test database
npm test                                             # full Jest project
npm run build
```

The current backend lint script includes ESLint’s `--fix` flag; run it from a branch or worktree if you need to inspect changes without keeping automatic fixes.

Frontend:

```bash
cd frontend
npm ci
npm run lint
npm run build
```

Cleaner Engine:

```bash
cd cleaner-engine
python3 -m pip install ".[dev]"
pytest -q
```

## Security

Please report vulnerabilities through the private reporting path described in [SECURITY.md](SECURITY.md). Do not open a public issue with credentials, tokens, private mail content, or an exploit that is still usable.

The API applies Helmet and request throttling, while the frontend configures CSP, HSTS, frame, content-type, referrer, and permissions headers. Provider webhooks and agent actions remain credential- and policy-gated in the backend.

## Licence

Email-Ops is licensed under the [Apache License 2.0](LICENSE). You can use, change and redistribute it, including commercially, under its terms. Our names and logos are covered by [TRADEMARKS.md](TRADEMARKS.md).

Built by [Magic Unicorn](https://magicunicorn.tech) · part of [Unicorn Commander](https://unicorncommander.ai)
