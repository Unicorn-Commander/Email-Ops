# Connect a phone to the Unicorn Commander calendar

This guide uses a Davis native app key so the phone has its own revocable
credential. The app key secret is shown once. Use a fictional/example mailbox
below only as a format reference; enter the mailbox you actually own.

## Before you start

The per-device Email-Ops app-key bridge is a deployment gate. Until it is
enabled, an administrator must issue the native Davis app key from the Davis
dashboard. The current Email-Ops mailbox-password reset changes the mailbox
password for every client and is not a per-device password.

Have these values ready:

- Server: `calendar.unicorncommander.ai`
- Username: `<mailbox-email>*<app-id>`
- Password: the one-time Davis app-key secret

Do not paste the secret into chat, tickets, screenshots, or a shared password
manager entry. If it is lost, revoke that key and create a new one.

## iPhone or iPad

1. Open **Settings → Apps → Calendar → Calendar Accounts → Add Account → Other**.
2. Choose **Add CalDAV Account**.
3. Enter the server, app-key username, and one-time secret above. Leave the
   description as a device label that does not contain a password.
4. Save, open Calendar, and confirm that the Davis calendar appears. Create a
   harmless test event, then remove it after sync is confirmed.

If discovery fails, retry with the server host only (without `https://`); iOS
will follow the CalDAV discovery path through the configured proxy.

## Android with DAVx5

1. Install DAVx5 from the approved device source and choose **+ → Login with
   URL and user name**.
2. Use `https://calendar.unicorncommander.ai/dav/` as the base URL, then enter
   the app-key username and one-time secret.
3. Choose the discovered account, enable the calendar collection, and set the
   sync interval appropriate for the device.
4. Confirm a harmless test event appears in both directions, then remove it.

DAVx5 can also discover CardDAV from the same account. Enable only the
collections the device needs.

## Lost or replaced device

Open the Email-Ops device list (or ask the operator to use the Davis admin
surface), revoke the named app key, and wait for the revocation to be confirmed.
Then create a new named key for the replacement phone. Do not simply rename a
key or reuse a copied secret.
