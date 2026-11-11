# Disconnect a Gmail or Microsoft mailbox

Disconnect removes the link between your own Email-Ops sign-in and one connected mailbox (Gmail or Microsoft 365). It stops Email-Ops from reading or acting on that mailbox through the link. It does not delete your mail, and it does not touch anyone else's mailbox or link.
<!-- backend/src/connected-accounts/connected-accounts.service.ts:172; frontend/app/accounts/DisconnectControl.tsx:103 -->

If you only want to connect a mailbox in the first place, see [Connect your own Gmail or Microsoft 365 mailbox](../connect-your-mailbox.md).

## Where the button is

1. Open **Accounts** (`/accounts`). Make sure the organization switcher shows the workspace you want.
2. On the card for the connected provider (Gmail or Microsoft 365), choose **Disconnect**. The button is greyed out until that provider is linked, and its tooltip says to connect the account first.
3. A confirmation dialog opens. Read it, then choose the red **Disconnect** button to continue, or **Cancel** to stop.
<!-- frontend/app/accounts/page.tsx:746; frontend/app/accounts/DisconnectControl.tsx:71; frontend/app/accounts/DisconnectControl.tsx:138 -->

The dialog tells you plainly what will happen: the provider link is removed from your sign-in, the mailbox is marked inactive, and your mail stays at the provider. It also links to your provider's own app-permissions page so you can revoke consent there too:

- Google: [Google Account third-party access](https://myaccount.google.com/connections)
- Microsoft: [Microsoft account app permissions](https://myaccount.microsoft.com/permissions)
<!-- frontend/app/accounts/DisconnectControl.tsx:13; frontend/app/accounts/DisconnectControl.tsx:107 -->

## What Disconnect removes

It acts only on your own link, for the one provider you chose:

1. It unlinks that provider from your Email-Ops sign-in in the identity broker (Gmail uses the `google` link, Microsoft 365 uses `microsoft`).
2. It marks your own mailbox records for that provider inactive, in every workspace you belong to. The records are kept, not deleted.
3. It clears your saved sign-in refresh token only when no other provider link still uses it. If you are still connected to the other provider, that token stays in place.
<!-- backend/src/connected-accounts/connected-accounts.service.ts:183; backend/src/connected-accounts/connected-accounts.service.ts:204; backend/src/connected-accounts/connected-accounts.service.ts:1799 -->

## What Disconnect keeps

- Your mail at Google or Microsoft. Nothing is deleted at the provider.
- Shared and team mailboxes. Only your own personal mailbox records are marked inactive.
- Other people's links and mailboxes in the same workspace. Your disconnect is matched to your own identity, so it cannot change another person's account.
- Your other provider. Disconnecting Gmail leaves a Microsoft 365 link connected, and the reverse.
- Application history. Disconnect does not erase past activity.
- The mailbox record itself. It is only flagged inactive, so it can be reconnected later. If the disconnected mailbox was your default, another active mailbox in that workspace becomes the default.
<!-- backend/src/connected-accounts/connected-accounts.service.ts:1827; backend/src/connected-accounts/connected-accounts.service.ts:1847 -->

## If you click Disconnect again

Nothing breaks. A second Disconnect on the same provider succeeds and reports that the link is already removed, with zero mailboxes newly marked inactive. There is no error to dismiss.
<!-- backend/src/connected-accounts/connected-accounts.service.ts:230; frontend/app/accounts/DisconnectControl.tsx:149 -->

## How to reconnect

Use **Connect** or **Reconnect** on the same Accounts card to run the provider sign-in again and relink the mailbox. After relinking, use **Add to Mail** if the mailbox is not already in your inbox.

If the success message said your saved sign-in refresh token was cleared, sign out of Email-Ops and sign back in before you connect again. That refreshes your session so the new link works.
<!-- frontend/app/accounts/page.tsx:740; frontend/app/accounts/DisconnectControl.tsx:156; docs/connect-your-mailbox.md -->

## If it does not go through

Disconnect changes nothing until the identity broker confirms the unlink. If it cannot, you see a message and your link and mailbox stay as they were:

- **Identity broker unavailable:** try again shortly. Nothing was changed.
- **Sign-in session expired:** sign out, sign back in, then try Disconnect again.
- **Broker refused the unlink:** report the message to your workspace administrator.
- **Link removed but the mailbox could not be marked inactive, or the token could not be cleared:** the message tells you which part did not finish. Try again.
- **No identity to match a mailbox:** this sign-in has no matching mailbox identity, so nothing was changed. Ask your administrator to check your account.

You must be signed in as a person to disconnect. An automation token cannot disconnect a mailbox. Any signed-in member of your workspace can disconnect their own link, and it only ever affects their own link.
<!-- backend/src/connected-accounts/connected-accounts.service.ts:185; backend/src/connected-accounts/connected-accounts.service.ts:195; backend/src/connected-accounts/connected-accounts.controller.ts:129; frontend/app/accounts/DisconnectControl.tsx:18 -->

## Notes for support

- The route is `POST /api/v1/connected-accounts/:provider/disconnect`. It refreshes the caller's broker token, unlinks the alias, then sets `active=false` on that user's HUMAN-owned mailbox rows for that provider. Rows are matched by owner key, so other users are never updated, and nothing is deleted.
- The saved Keycloak refresh token is shared across providers, so it is cleared only when the broker reports the other provider's alias is gone.
- The route gate checks workspace membership only. It does not check the member's role, so any active member (including a viewer) can disconnect their own link today.
- Disconnect does not write an audit entry, and it does not clear a mailbox sync cursor. Deactivation flips the active flag only.
<!-- backend/src/connected-accounts/connected-accounts.controller.ts:117; backend/src/connected-accounts/connected-accounts.service.ts:172; backend/src/connected-accounts/connected-accounts.service.ts:1827 -->

## Related

- [Connect your own Gmail or Microsoft 365 mailbox](../connect-your-mailbox.md)
- [Connect a mailbox from another provider (IMAP, read only)](connect-other-mailbox.md)
