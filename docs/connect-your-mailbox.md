# Connect your own Gmail or Microsoft 365 mailbox

You can use your existing mailbox in Email-Ops. You do not need an address on our domain, a new hosted mailbox, or a DNS change. Your mail continues to live at Google or Microsoft. Connecting lets Email-Ops read and act on that mailbox through the provider's API.
<!-- backend/src/mailbox-accounts/mailbox-accounts.controller.ts:398; backend/src/mailbox-accounts/mailbox-accounts.service.ts:264; backend/src/mail-provider/engine-mail-provider.ts:49 -->

## Connect and open Mail

1. Sign in to Email-Ops through SSO, accept your workspace invitation if needed, and select your customer workspace in the organization switcher. An SSO login alone does not grant workspace membership. If you cannot sign in or see the workspace, ask your pilot administrator to finish onboarding.
   <!-- backend/src/auth/auth.service.ts:330; backend/src/auth/auth.service.ts:392; backend/src/common/workspace/membership.service.ts:9; frontend/components/ActiveWorkspaceProvider.tsx:115 -->
2. Open **Mail** (`/mail`). With no active mailboxes, the inbox shows **Connect Gmail** and **Connect Microsoft 365**. Choose your provider. If you already linked it, follow **Already connected? Add to Mail on Accounts** instead.
   <!-- frontend/app/mail/page.tsx:1265; frontend/components/mail/useMailClient.ts:408; frontend/components/mail/ListBannerView.tsx:44 -->
3. In the provider sign-in/consent screen, select **your own mailbox account** and review the requested access. This can be a different address from your Email-Ops login. Return to Email-Ops after consenting. If the provider blocks access or requires your organization's administrator, ask the pilot administrator to resolve it before continuing.
   <!-- frontend/components/mail/ListBannerView.tsx:25; backend/src/mailbox-accounts/mailbox-accounts.controller.ts:414 -->
4. You return to **Accounts** (`/accounts`). Linking alone does **not** create an inbox entry. On the linked provider's card, choose **Add to Mail**. Confirm the organization switcher still shows your customer workspace before clicking. If Add to Mail stays disabled, your workspace, profile, or broker link has not resolved successfully.
   <!-- frontend/app/accounts/page.tsx:34; frontend/app/accounts/page.tsx:62; frontend/app/accounts/page.tsx:642; frontend/app/accounts/page.tsx:752 -->
5. Check the address shown under **Added to Mail**, then choose **Open /mail**. If the address is wrong, stop and contact your pilot administrator. The backend normally asks the provider for the address, but falls back to your Email-Ops profile address when that lookup fails.
   <!-- frontend/app/accounts/page.tsx:647; frontend/app/accounts/page.tsx:755; backend/src/mailbox-accounts/mailbox-accounts.controller.ts:414; backend/src/mail-provider/engine-mail-provider.ts:362 -->
6. Mail loads the first page of inbox conversations from your provider. Open a conversation to read its contents. This is a live view, not a full mailbox import. While Mail is visible, it refreshes approximately every 30 seconds; you can also use Refresh.
   <!-- frontend/components/mail/useMailClient.ts:67; frontend/components/mail/useMailClient.ts:408; frontend/components/mail/useMailClient.ts:492; frontend/components/mail/useMailClient.ts:931; backend/src/email/email.service.ts:758; backend/src/mail-provider/engine-mail-provider.ts:122 -->

You can also start from **Accounts**, using **Connect Google** or **Connect Microsoft**. **Reconnect** repeats the broker link flow if reading or analysis stops working. For this pilot, use one linked mailbox per provider per Email-Ops identity; the code resolves the current provider token by user and provider, not by a separate mailbox credential. Relinking a different account can therefore affect existing mailbox entries.
<!-- frontend/app/accounts/page.tsx:720; frontend/app/accounts/page.tsx:841; backend/src/mail-provider/engine-mail-provider.ts:387; backend/src/mail-provider/engine-mail-provider.ts:412 -->

## What access is requested, and why?

There are two consent layers. Email-Ops SSO requests `openid`, `profile`, `email`, and `offline_access`: identity information and a refreshable SSO session. Mail access is granted separately to the Google or Microsoft application configured in the Keycloak identity broker. The app does not set provider scopes when you click Connect, so the actual consent screen depends on that deployment's broker configuration.
<!-- backend/src/auth/strategies/keycloak.strategy.ts:28; backend/src/auth/keycloak-broker.service.ts:48; backend/src/connected-accounts/connected-accounts.service.ts:152 -->

The provider implementations describe the following access requirements:

| Provider | Access reflected in this repository | Purpose |
| --- | --- | --- |
| Gmail | `https://mail.google.com/`, `gmail.readonly`, `gmail.send` (the latter two use the Google API scope prefix) | Read conversations and labels, send mail, and perform mailbox actions. The full-mail scope is explicitly required by the engine's permanent batch-delete operation; `gmail.modify` alone is insufficient for that operation. |
| Microsoft 365 | `Mail.ReadWrite`, `Mail.Send`, `User.Read` | Read and organize messages, create drafts, send mail, and identify the linked account. |
<!-- cleaner-engine/providers/gmail_provider.py:70; cleaner-engine/providers/microsoft_provider.py:41; cleaner-engine/providers/microsoft_provider.py:172 -->

These lists describe code requirements, not proof that a deployed provider app has been approved or grants those scopes. The pilot administrator must confirm the configured permissions and external-customer eligibility. Granting mail access is broader than reading metadata: the reader retrieves message bodies and attachments, and sends and mailbox actions use the same brokered account. Cleanup analysis, when used, categorizes sender/subject metadata through the configured AI gateway; that metadata-only behavior is specific to categorization, not a promise about every feature.
<!-- backend/src/mail-provider/engine-mail-provider.ts:122; backend/src/mail-provider/engine-mail-provider.ts:153; backend/src/mail-provider/engine-mail-provider.ts:335; cleaner-engine/ai/llm_analyzer.py:172 -->

## Disconnect and retained data

The **Disconnect** button on Accounts is currently disabled. To withdraw provider access, revoke the application's consent in your Google or Microsoft account's authorized-app/security settings; your Microsoft organization may require its administrator to do this. Ask the pilot administrator to remove the corresponding broker link if necessary. Email-Ops has no implemented self-service broker unlink/revoke endpoint in this flow. Signing out of Email-Ops only clears its session cookies; it does not revoke provider access.
<!-- frontend/app/accounts/page.tsx:742; backend/src/connected-accounts/connected-accounts.controller.ts:93; backend/src/auth/auth.controller.ts:95 -->

Revoking consent does not delete your Google/Microsoft mailbox, remove the Email-Ops mailbox record, or erase application history. Ask the pilot administrator about removing the local mailbox entry and any retained data. Mailbox record deletion is blocked while messages, agents, send kits, or standing approvals still reference it; it is not an account-erasure workflow. A broker token may still appear present after consent revocation, so the Accounts badge alone is not confirmation that access is usable or revoked.
<!-- backend/src/mailbox-accounts/mailbox-accounts.service.ts:435; backend/src/connected-accounts/connected-accounts.service.ts:133 -->

| Data | Where it goes |
| --- | --- |
| Existing mail | Google/Microsoft remains authoritative. Mail reads travel through the backend and Cleaner Engine to your browser; bodies and attachment bytes are fetched when requested. Connecting does not bulk-copy the mailbox into a hosted Email-Ops mailbox. |
| Provider credentials | The provider token is retrieved from Keycloak by the backend and passed to the Cleaner Engine for each request. The mailbox record has no provider secret. The backend stores an encrypted **Keycloak refresh token** on your user record. |
| Workspace data | Email-Ops stores the mailbox address, provider, owner identity, workspace association, and an audit event. Actions can additionally store message bodies for sends, drafts/approvals, cleanup history, and other application records. Revocation does not purge these. |
| Cleanup archives and AI | Cleanup may create verified archives in configured object storage. AI features can send their selected input to the configured model gateway; categorization sends IDs, senders and subjects. Ask your pilot administrator about deployment-specific retention and model hosting. |
<!-- backend/src/mailbox-accounts/mailbox-accounts.service.ts:289; backend/src/auth/auth.service.ts:568; backend/src/connected-accounts/crypto.ts:3; backend/src/auth/keycloak-broker.service.ts:20; backend/src/mail-provider/engine-mail-provider.ts:122; cleaner-engine/README.md:5; backend/src/email/email.service.ts:2234; backend/src/connected-accounts/connected-accounts.service.ts:1312; cleaner-engine/ai/llm_analyzer.py:172 -->

## If the connection does not finish

- **Cannot sign in / no workspace:** ask the pilot administrator to check your verified identity and either entitled-workspace onboarding or an invitation and its acceptance. Without successful onboarding, the existing admission and membership gates can deny access.
- **SSO session expired / cannot start linking:** sign out and sign back in through SSO, then retry Connect in that browser. A local-only login does not supply the Keycloak session needed for this flow.
- **Provider denies consent or rejects a redirect:** report the visible error and the pilot environment to the administrator. Provider approval, tenant consent, and redirect allowlists are outside the mailbox screen.
- **Linked, but no mailbox in Mail:** choose **Add to Mail** on Accounts, verify the selected workspace and returned address, and open Mail again.
- **Mailbox exists, but Mail says it is unavailable:** the inbox distinguishes an empty folder from a failed read. Reconnect the account when asked, or Try again. “Mail service is not available right now” means the Cleaner engine is unwired or unreachable — your mail is still at the provider. A true empty folder still shows the normal empty state.
- **Analysis is unavailable:** the `email-ops` entitlement and Cleaner Engine must be available. Linking and adding an external mailbox do not require the hosted-mailbox add-on.
<!-- backend/src/auth/auth.service.ts:330; backend/src/auth/auth.service.ts:392; backend/src/auth/keycloak-broker.service.ts:48; backend/src/connected-accounts/connected-accounts.service.ts:152; frontend/app/accounts/page.tsx:642; backend/src/mail-provider/engine-mail-provider.ts:49; cleaner-engine/app.py:589; backend/src/connected-accounts/connected-accounts.controller.ts:130; backend/src/connected-accounts/entitlement.ts:39 -->

## Implementation trace for pilot support

1. **Entry:** `/mail` resolves the active workspace and lists its active mailboxes. Only a successfully loaded empty list selects `no-mailboxes`; loading, request errors, missing membership and an empty selected space remain separate states. The extracted banner starts the existing `getProviderLinkUrl('gmail' | 'microsoft')` helper without a feature flag.
   <!-- frontend/components/mail/useMailClient.ts:390; frontend/app/mail/page.tsx:1265; frontend/app/mail/page.tsx:2660; frontend/components/mail/ListBannerView.tsx:25; frontend/lib/api.ts:1564 -->
2. **SSO bootstrap:** `/api/v1/auth/keycloak` starts the OIDC flow. Its `/api/v1/auth/keycloak/callback` resolves the user, stores the encrypted Keycloak refresh token through the strategy, sets the app session cookie, and redirects to `/auth/sso-callback`. This login callback is distinct from the provider-link return.
   <!-- backend/src/auth/auth.controller.ts:37; backend/src/auth/strategies/keycloak.strategy.ts:48; backend/src/auth/auth.service.ts:568; frontend/app/auth/sso-callback/page.tsx:8 -->
3. **Broker link:** authenticated `GET /api/v1/connected-accounts/:provider/link-url` checks workspace access, maps `gmail` to the broker alias `google`, refreshes the user's Keycloak token, and builds a nonce/hash-bound `/realms/{realm}/broker/{alias}/link` URL. The browser needs the matching Keycloak SSO session. The return URL is server-derived: `${FRONTEND_URL}/accounts?linked=gmail` (or `microsoft`). Provider authorization/exchange happens in Keycloak, outside this repository. Each pilot ring needs matching SSO, broker and frontend URLs/allowlists; the provider callback registration must be checked in that ring's broker configuration.
   <!-- backend/src/connected-accounts/connected-accounts.controller.ts:113; backend/src/connected-accounts/connected-accounts.service.ts:152; backend/src/connected-accounts/connected-accounts.service.ts:1727; backend/src/auth/keycloak-broker.service.ts:48 -->
4. **Return and status:** Accounts refreshes linked status and removes `?linked=…`. `GET /connected-accounts` and the MCP `list_connected_accounts` tool both probe for a token from `/broker/{alias}/token`; neither creates a mailbox or validates the provider's granted scopes. The MCP stats/analysis tools use the same broker/engine path and require `email-ops`. REST connected-account routes resolve the default membership, while Add to Mail explicitly targets the selected workspace; multi-workspace entitlement differences need attention.
   <!-- frontend/app/accounts/page.tsx:62; backend/src/connected-accounts/connected-accounts.service.ts:133; backend/src/auth/keycloak-broker.service.ts:219; backend/src/mcp/mcp.tools.ts:1472; backend/src/mcp/mcp.service.ts:741; backend/src/connected-accounts/connected-accounts.controller.ts:282 -->
5. **Record creation:** Add to Mail posts to `/api/v1/workspaces/:workspaceId/mailboxes/connected`. The controller resolves the address via the engine's `/accounts/profile`, falling back to the supplied profile email. The service upserts by workspace/address, marks the mailbox HUMAN-owned with the canonical user identity and external provider, makes it default if needed, and records `MAILBOX_CREATED`. It does not provision a hosted mailbox or enqueue an initial full sync.
   <!-- frontend/lib/mailApi.ts:347; backend/src/mailbox-accounts/mailbox-accounts.controller.ts:398; backend/src/mail-provider/engine-mail-provider.ts:362; backend/src/connected-accounts/connected-accounts.client.ts:357; backend/src/mailbox-accounts/mailbox-accounts.service.ts:264 -->
6. **Initial load and subsequent sync:** opening Mail fetches live threads through `EmailService` → `EngineMailProvider` → Cleaner Engine `/mail/threads` → Google/Microsoft. The browser refresh loop runs while visible. Separately, the optional inbound watcher runs once per minute only when `INBOUND_WATCHER_ENABLED` is enabled, and includes external mail only with `INBOUND_WATCHER_EXTERNAL_ENABLED`. Its first provider poll establishes a cursor without processing the existing backlog; subsequent polls classify new mail and apply configured rules. This watcher is not required to display the inbox, and is not a historical mailbox import.
   <!-- backend/src/email/email.service.ts:758; backend/src/mail-provider/engine-mail-provider.ts:49; backend/src/connected-accounts/connected-accounts.client.ts:364; cleaner-engine/app.py:589; frontend/components/mail/useMailClient.ts:931; backend/src/inbound/inbound-watcher.service.ts:46; backend/src/common/workspace/feature-flags.ts:83; cleaner-engine/providers/gmail_provider.py:91; cleaner-engine/providers/microsoft_provider.py:54 -->

## Local regression check

The change is limited to the inbox banner, its mounting import, this guide and a hermetic Vitest test. The frontend has no committed Vitest dependency; install a temporary pinned runner without changing manifests or the lockfile:

```bash
cd frontend
npm ci --no-audit --no-fund
npm install --no-save --package-lock=false --no-audit --no-fund vitest@3.2.4
./node_modules/.bin/vitest run components/mail/ListBannerView.test.mjs components/mail/MailUnavailableView.test.mjs --maxWorkers=2
```

The tests mock the broker helper and reject network fetches. They cover both provider redirects, pending/error/retry states, and separation from loading, missing-workspace, request-error and empty-space states. Restore locked dependencies with `npm ci` before running the frontend CI build. CI also attempts `npm run lint` non-blockingly; this repository currently prompts for ESLint configuration.
<!-- frontend/components/mail/ListBannerView.test.mjs:1; frontend/package.json:5; .forgejo/workflows/ci.yml:128 -->
