# Davis calendar for Email-Ops

This directory is the Phase-1 deployment lane for the Unicorn Commander suite
calendar. It pins the bare PHP-FPM Davis image to
`ghcr.io/tchapi/davis:v5.6.2` and keeps the calendar database separate from
James. No deployment, DNS change, certificate issuance, SSH, or secret
creation is performed by this repository lane.

## Architecture

```text
Internet
   |
   | https://calendar.unicorncommander.ai:443
   v
existing jmap-proxy (nginx, TLS termination, James compose network)
   |
   +--> davis-web (nginx:alpine, internal port 80)
          |
          +--> davis (Davis PHP-FPM, internal port 9000)
          |       |
          |       +--> davis-postgres (postgres:16-alpine)
          |
          +--> davis_internal (private application/database network)

davis also joins the James compose network for:
  IMAP  -> james-prod-app:143 (plain internal IMAP)
  SMTP  -> james-prod-app:587 (submission)
```

`davis-web` and `davis` share the named `mail_calendar_davis_www` volume so the
nginx tier can serve Davis's `public/` files while PHP-FPM executes the same
image's `public/index.php`. `davis-postgres` is reachable only on
`davis_internal`; it is not James's database and no host database port is
published. The external network name is supplied by `JAMES_COMPOSE_NETWORK`.

Files in this lane:

- `docker-compose.yml` is the PostgreSQL default with healthchecks, restart
  policies, memory limits, and JSON log rotation.
- `docker-compose.mariadb.yml` is an explicit MariaDB 11 fallback.
- `nginx/davis-web.conf` is the internal nginx-to-FPM configuration.
- `nginx/calendar.unicorncommander.ai.conf` is the server block appended to
  the existing `jmap-proxy` configuration.
- `scripts/backup.sh`, `scripts/restore.md`, and the systemd units cover the
  database backup/restore path.
- `scripts/smoke.sh` is the post-deploy wire-level check.

## Authentication and app keys

Davis uses `AUTH_METHOD=IMAP` against James at `james-prod-app:143`. Every
James mailbox is therefore a potential calendar/contact account with the same
full-email login. With `IMAP_AUTH_USER_AUTOCREATE=true`, Davis creates the
account on the first successful IMAP login. The internal hop is plain IMAP on a
private Docker network; it is never published to the Internet.

`APP_KEYS_ENABLED=true` enables Davis app keys. The administrator issues a key
from the Davis dashboard now; Email-Ops can automate issuance later. A client
using an app key authenticates as `<login>*<app_id>` with the one-time key
secret as its password. The ordinary login must already exist before an app key
can act for it, including when IMAP is the selected auth provider. Prefer app
keys for phones and integrations so the mailbox password is not stored in each
client.

The dashboard is at `/dashboard` and uses `ADMIN_LOGIN` / `ADMIN_PASSWORD`,
which are separate from mailbox authentication. `AUTH_REALM` should not be
changed after installation if legacy Davis password hashes exist.

Invitations use James submission through `MAILER_DSN` and are sent from
`calendar@unicorncommander.ai`. The James mailbox/password in that DSN must be
provisioned and URL-encoded by the operator; no value belongs in this repo.

## Deploy on your-mail-host

The commands below are an operator handoff. Resolve all `CHANGE_ME` values and
the actual repository path before running them.

1. Create DNS first:

   - Add an A record for `calendar.unicorncommander.ai` to `203.0.113.10`.
   - Keep it DNS-only. This record must override the existing
     `*.unicorncommander.ai` wildcard.

2. On `your-mail-host`, identify the James compose network instead of guessing it:

   ```sh
   docker inspect james-prod-app --format '{{json .NetworkSettings.Networks}}'
   docker network ls
   ```

   Set `JAMES_COMPOSE_NETWORK` in `.env` to the network that contains both
   `james-prod-app` and `jmap-proxy` (the expected name is often
   `james-prod_default`).

3. Install the lane beside the deployed Email-Ops checkout, create the ignored
   runtime environment, and set its mode:

   ```sh
   cd /home/deploy/Email-Ops/infrastructure/calendar/davis
   cp .env.example .env
   chmod 600 .env
   openssl rand -hex 32
   $EDITOR .env
   ```

   Set a unique Davis Postgres password, dashboard password, SMTP password,
   and `APP_SECRET`. Keep the raw database password in the Postgres service
   variable and put its URI-encoded form in `DATABASE_URL`; do the same for
   `MAILER_DSN`. Set the James database/user variables from the live James
   compose configuration.

4. Validate the rendered stack, pull the pinned images, and start the stack:

   ```sh
   docker compose --env-file .env config -q
   docker compose pull
   docker compose up -d
   docker compose exec -T davis sh -c \
     'APP_ENV=prod bin/console doctrine:migrations:migrate --no-interaction'
   ```

   The first migration creates Davis's schema. Do not use `docker compose
   down -v`; it would remove the database volume.

5. Issue the calendar certificate before enabling the new proxy server block.
   The script is idempotent when both live certificate files already exist:

   ```sh
   ./scripts/issue-cert.sh
   ```

   Certbot standalone needs host port 80. Coordinate with the existing
   `renew-cert.sh` cron job and stop/restore the current port-80 proxy only
   according to the host's established procedure; never run two standalone
   certbot jobs at once. The certificate is written under the existing
   `/home/deploy/james-prod/letsencrypt` tree, which is mounted into `jmap-proxy`
   as `/etc/letsencrypt`.

6. Append `nginx/calendar.unicorncommander.ai.conf` to the host's
   `/home/deploy/james-prod/nginx-jmap-443.conf`, then test and reload the existing
   proxy:

   ```sh
   docker exec jmap-proxy nginx -t
   docker exec jmap-proxy nginx -s reload
   ```

   The block sends both `/.well-known/caldav` and `/.well-known/carddav` to
   `/dav/`, forwards the original host/proto/client headers, and keeps DAV
   request buffering disabled. The host's port 80 remains a certbot-standalone
   concern during renewals.

7. Run the authenticated smoke test with a password file. The password itself
   must never appear as a command-line argument:

   ```sh
   ./scripts/smoke.sh https://calendar.unicorncommander.ai \
     user@example.com /secure/path/to/password-file
   ```

## Backups and restore

The default `scripts/backup.sh` runs `pg_dump -Fc` inside both
`james-prod-postgres` and `davis-postgres`. Dumps are gzip-free custom archives
named `<host>_<db>_<UTC timestamp>.dump` under
`/home/deploy/backups/mail-calendar/`. It rejects empty output, keeps the newest
14 archives per database, and runs `rsync -a` to `BACKUP_RSYNC_TARGET` when that
value is non-empty. An empty target is a warning and a deliberate off-box
backup gap, not a successful off-box backup.

Install the timer after the real repository path and `.env` are in place:

```sh
sudo install -m 0644 systemd/mail-calendar-backup.service \
  /etc/systemd/system/mail-calendar-backup.service
sudo install -m 0644 systemd/mail-calendar-backup.timer \
  /etc/systemd/system/mail-calendar-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now mail-calendar-backup.timer
systemctl list-timers mail-calendar-backup.timer
sudo systemctl start mail-calendar-backup.service
```

The service runs as `muut`, so that account needs Docker socket access and
write access to `/home/deploy/backups/mail-calendar`. Read
[scripts/restore.md](scripts/restore.md) before treating a backup as
recoverable. James currently has no backups, so the first successful
two-database run and an off-box copy are explicit gates.

## PostgreSQL gate and MariaDB fallback

Davis documents PostgreSQL as not extensively tested. Run
[scripts/upstream-tests.md](scripts/upstream-tests.md) against a throwaway
Postgres container as the Phase-1 gate and record the output before production
use.

If that gate fails and the operator explicitly approves the fallback, set the
MariaDB variables in `.env`, set `DAVIS_DATABASE_ENGINE=mariadb`, and use both
compose files consistently:

```sh
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.mariadb.yml config -q
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.mariadb.yml up -d
docker compose --env-file .env \
  -f docker-compose.yml -f docker-compose.mariadb.yml exec -T davis sh -c \
  'APP_ENV=prod bin/console doctrine:migrations:migrate --no-interaction'
```

The fallback keeps the service name `davis-postgres` only to preserve the
network and backup procedure shape; its image and volume are MariaDB-specific.
Its Davis archive is plain, gzip-free SQL rather than PostgreSQL custom format;
the restore section documents that difference. Do not delete the unused
PostgreSQL volume when switching so rollback remains possible after a fresh
backup.

## Pin and upgrade policy

The Davis application image is pinned to `v5.6.2`; do not replace it with
`latest`, `edge`, or the standalone Caddy image. Review a release, rerun the
upstream PHPUnit gate, take and verify both database backups, then update the
tag and run the documented migrations. Review the resulting image digest on
the host before accepting the upgrade. Keep the external proxy/certificate
configuration and the Davis database volume across upgrades. The shared
application volume is code/runtime state, not calendar data; if an image
upgrade needs a fresh copy of `public/`, refresh only
`mail_calendar_davis_www` after stopping Davis and nginx, never the database
volume.

## Client connection details

Use `calendar.unicorncommander.ai` as the server and the full mailbox email as
the user identity. Prefer the Davis app-key form `<full email>*<app_id>` as the
username and the generated app-key secret as the password.

- iPhone/iPad: Settings -> Calendar -> Accounts -> Add Account -> Other -> Add
  CalDAV Account. Server: `calendar.unicorncommander.ai`; user: full email or
  app-key login.
- Android: use a CalDAV/CardDAV client such as DAVx5. Select the server
  `calendar.unicorncommander.ai`, use the full email/app-key login, and allow
  DAVx5 to discover `/dav/`.
- macOS: System Settings -> Internet Accounts -> Add Other Account -> Add
  CalDAV Account. Server: `calendar.unicorncommander.ai`; user: full email or
  app-key login.

CardDAV uses the same server and auth model because `CARDDAV_ENABLED=true`.
The server may auto-provision the account only after the first successful
IMAP-backed login.

## Known limits

- There is no mobile push service; clients sync on their normal schedule.
- There is one maintainer for this lane.
- PostgreSQL support is the selected default but upstream describes it as not
  extensively tested; the MariaDB override is the documented fallback.
- The existing James HTTPS proxy, certificate renewal, DNS, and mailbox
  lifecycle remain external approval/deployment responsibilities.
