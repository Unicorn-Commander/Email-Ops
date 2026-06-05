# Cleaner Engine

Stateless HTTP microservice for Email-Ops. NestJS calls this service for provider access, inbox analysis, and AI-assisted cleanup.

## Contract

- All endpoints except `POST /health` require the header `X-Engine-Token: <ENGINE_SHARED_SECRET>`.
- The service persists nothing. Provider credentials are passed on every request and used only for that request.
- AI endpoints degrade cleanly when `LITELLM_BASE_URL` is empty:
  - `POST /ai/chat` returns `{"response":"ai_unavailable: LITELLM_BASE_URL is not configured"}`
  - `POST /ai/analyze` still performs the statistical inbox analysis, but returns `ai_status: "ai_unavailable"` with empty `ai_categories` and `recommendations`

## Running

```bash
uvicorn app:app --host 0.0.0.0 --port 8000
```

## Endpoint Summary

### `POST /health`
No auth header required.

Request:

```json
{}
```

Response:

```json
{"status":"ok","version":"0.1.0"}
```

### `POST /auth/oauth-url`
Returns an OAuth authorization URL for Gmail or Microsoft 365.

Request:

```json
{"provider":"gmail","redirect_uri":"https://example.com/callback"}
```

Response:

```json
{"url":"https://..."}
```

### `POST /auth/exchange`
Exchanges an OAuth code for provider credentials.

Request:

```json
{"provider":"gmail","code":"...","redirect_uri":"https://example.com/callback"}
```

Response:

```json
{"token":"...","refresh_token":"..."}
```

### `POST /accounts/profile`
Authenticates the provider with the supplied credentials and returns the user profile.

Request:

```json
{"provider":"gmail","credentials":{"token":"...","refresh_token":"..."}}
```

Response:

```json
{"email":"user@example.com","display_name":"","total_messages":0,"total_threads":0,"storage_used_bytes":0,"storage_limit_bytes":0}
```

### `POST /accounts/stats`
Returns inbox counts.

Request:

```json
{"provider":"gmail","credentials":{"token":"..."}}
```

Response:

```json
{"total_messages":0,"total_threads":0,"unread_count":0,"promotional_count":0,"social_count":0,"storage_used_bytes":0}
```

### `POST /messages/list`
Lists messages matching a query.

Request:

```json
{"provider":"gmail","credentials":{"token":"..."},"query":"category:promotions","max_results":100,"page_token":null}
```

Response:

```json
{"messages":[...],"next_token":null}
```

### `POST /messages/get`
Returns a single message.

Request:

```json
{"provider":"gmail","credentials":{"token":"..."},"message_id":"abc","format":"metadata"}
```

Response:

```json
{"id":"abc","subject":"..."}
```

### `POST /cleanup/trash`
Moves messages to trash.

Request:

```json
{"provider":"gmail","credentials":{"token":"..."},"message_ids":["a","b"]}
```

Response:

```json
{"count":2}
```

### `POST /cleanup/delete`
Permanently deletes messages.

Request:

```json
{"provider":"gmail","credentials":{"token":"..."},"message_ids":["a","b"]}
```

Response:

```json
{"count":2}
```

### `POST /ai/analyze`
Runs inbox analysis and streams Server-Sent Events.

Request:

```json
{"provider":"gmail","credentials":{"token":"..."}}
```

Response content type: `text/event-stream`

Event shape:

```text
event: progress
data: {"id":null,"stage":"fetch","percent":0,"message":"Fetching messages..."}

event: progress
data: {"id":null,"stage":"metadata","percent":40,"message":"Fetching message details..."}

event: result
data: {"sender_frequency":{...},"age_distribution":{...},"categories":{...},"size_distribution":{...},"total_messages":123,"ai_categories":[...],"recommendations":[...]}
```

When `LITELLM_BASE_URL` is empty, the final `result` event includes:

```json
{"ai_status":"ai_unavailable","ai_categories":[],"recommendations":[]}
```

### `POST /ai/chat`
Answers a question about the inbox.

Request:

```json
{"message":"What should I delete?","context":{"total_messages":123}}
```

Response:

```json
{"response":"..."}
```

### `POST /ai/models`
Returns the configured LiteLLM model IDs.

Request:

```json
{}
```

Response:

```json
{"models":["local/qwen3.5-9b","..."]}
```

### `POST /backup/create`
Creates a JSON backup at the supplied path.

Request:

```json
{"provider":"gmail","credentials":{"token":"..."},"query":"","path":"/tmp/backup"}
```

Response:

```json
{"version":"1.0","created_at":"...","query":"","total_messages":10,"errors":0,"path":"/tmp/backup","provider":"gmail"}
```

### `POST /backup/verify`
Verifies a backup directory.

Request:

```json
{"path":"/tmp/backup"}
```

Response:

```json
{"success":true,"message":"Backup verified: 10 messages intact","total_messages":10}
```

## NestJS Call Pattern

Every request from the NestJS backend should:

1. Send `Content-Type: application/json`
2. Send `X-Engine-Token: <ENGINE_SHARED_SECRET>`
3. Include the provider name and provider credentials in the request body

Example:

```bash
curl -X POST http://cleaner-engine:8000/accounts/stats \
  -H 'Content-Type: application/json' \
  -H 'X-Engine-Token: REMOVED' \
  -d '{
    "provider": "gmail",
    "credentials": {
      "token": "..."
    }
  }'
```

For `POST /ai/analyze`, the NestJS backend should read the response as an SSE stream and react to `event: progress` updates before consuming the final `event: result`.
