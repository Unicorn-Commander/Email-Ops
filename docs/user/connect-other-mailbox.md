# Connect a mailbox from another provider (IMAP, read only)

You can bring a mailbox from another provider, for example Zoho Mail, into Email-Ops over IMAP. Email-Ops reads your INBOX so you can browse and open messages, download attachments, and mark messages read or unread. Your mail stays at the provider. This connection is read only: you cannot send from it yet.
<!-- docs/connect-other-imap.md:3 -->

If you want to connect your own Gmail or Microsoft 365 mailbox instead, see [Connect your own Gmail or Microsoft 365 mailbox](../connect-your-mailbox.md).

## You only see this control if your workspace is enabled for it

The **Connect another provider (IMAP)** button appears only when your workspace has been turned on for external IMAP. Email-Ops checks this before showing the button, so if your workspace is not enabled you will not see it at all, and the rest of the Connect screen looks normal. If you expect it and cannot see it, ask your workspace administrator.
<!-- frontend/components/mail/ExternalImapConnect.tsx:47; frontend/components/mail/ExternalImapConnect.tsx:88; backend/src/external-imap/imap-connection.ts:14 -->

## Where the control is

1. Open **Mail** (`/mail`) and make sure the workspace you want is selected.
2. On the **No mailboxes yet** screen, below **Connect Gmail** and **Connect Microsoft 365**, choose **Connect another provider (IMAP)**. A short form opens.
<!-- frontend/components/mail/ListBannerView.tsx:73; frontend/components/mail/ExternalImapConnect.tsx:91 -->

## What to enter

Ask your provider for its incoming mail (IMAP) settings first. Then fill in the form:

| Field | What to enter | Example |
| --- | --- | --- |
| Mailbox email address | The address of the mailbox you are connecting | `reader@example.com` |
| IMAP hostname | The incoming server your provider shows for this account | `imap.example.com` |
| Username | Usually your full mailbox address | `reader@example.com` |
| App password | A dedicated app password from your provider, not your sign-in password | (from your provider) |
| Port | Fixed at `993`, secure TLS only. You cannot change it. | `993` |
<!-- frontend/components/mail/ExternalImapConnect.tsx:105; frontend/components/mail/ExternalImapConnect.tsx:130; frontend/components/mail/ExternalImapConnect.tsx:67 -->

Use an **app password**, not your normal account password. Most providers create one for you in their security settings and let you delete it later without changing your main password. Keep your account's two-step verification turned on. For Zoho Mail, turn on IMAP access for the account and generate an app password in its security settings, then copy the incoming server shown for that account.

## Test the connection

Choose **Test connection**. The button stays disabled until every field has something in it. Email-Ops opens a secure TLS connection to port 993, signs in, and opens your INBOX. A test passes only when both the sign-in and the INBOX open succeed. You then see one of these short messages:

- **Connection successful. INBOX is available.** Everything worked.
- **Sign-in failed. Check your username, app password, and IMAP access setting.** The username or app password is wrong, or IMAP access is off at the provider.
- **A secure TLS connection could not be established. Check the hostname and certificate.** The hostname is wrong or the server's certificate was not accepted.
- **The IMAP inbox could not be reached. Check the hostname and try again.** The server name, network, or INBOX could not be reached.

These messages never show your password or the provider's raw error text.
<!-- frontend/components/mail/ExternalImapConnect.tsx:9; frontend/components/mail/ExternalImapConnect.tsx:138; backend/src/external-imap/imap-connection.ts:139; backend/src/external-imap/imap-connection.ts:157 -->

## Connect the mailbox

After a successful test, choose **Connect mailbox**. Email-Ops runs the same check once more and, if it passes, saves the mailbox and refreshes your mailbox list. The mailbox belongs to your own sign-in and is not made your default sending address. The form clears your entries, including the app password, when it finishes.
<!-- frontend/components/mail/ExternalImapConnect.tsx:76; backend/src/external-imap/external-imap.accounts.ts:29 -->

## What works after you connect

- Browse your INBOX and open messages (plain text and HTML).
- Download attachments.
- Mark messages read or unread.

## What does not work yet

- **Sending.** The form and the mail screen both say "Sending from this mailbox is not available yet." You can read this mailbox in Email-Ops, but you still send from the provider or from another connected mailbox.
- Only the INBOX is available. Other folders, search, and moving or deleting messages are not part of this connection.
<!-- frontend/components/mail/ExternalImapConnect.tsx:102; frontend/app/mail/page.tsx:1394; docs/connect-other-imap.md:184 -->

## Disconnect

There is no separate disconnect button for this kind of mailbox yet. To stop Email-Ops from reaching the mailbox right away, delete or revoke the app password at your provider. That blocks the connection on the provider side, and nothing is deleted from your mailbox. To reconnect later with a new app password, an owner of the same address can run Connect again.
