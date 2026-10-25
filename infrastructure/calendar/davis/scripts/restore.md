# Mail/calendar database restore

These procedures are destructive to the selected database. Confirm the archive
with `pg_restore --list` first, stop the application that writes the database,
and keep the original archive until the restored service passes `smoke.sh`.
The commands assume the host has the real `.env` beside this file and that the
Postgres containers are named `james-prod-postgres` and `davis-postgres`.

## Common preparation

```sh
cd /home/deploy/Email-Ops/infrastructure/calendar/davis
set -a
. ./.env
set +a

JAMES_ARCHIVE="/home/deploy/backups/mail-calendar/${BACKUP_HOST}_${JAMES_POSTGRES_DB}_YYYYMMDDTHHMMSSZ.dump"
DAVIS_ARCHIVE="/home/deploy/backups/mail-calendar/${BACKUP_HOST}_${DAVIS_POSTGRES_BACKUP_DB}_YYYYMMDDTHHMMSSZ.dump"

test -s "$JAMES_ARCHIVE"
test -s "$DAVIS_ARCHIVE"
docker run --rm -v "$JAMES_ARCHIVE:/restore/archive.dump:ro" postgres:16-alpine \
  pg_restore --list /restore/archive.dump | less
docker run --rm -v "$DAVIS_ARCHIVE:/restore/archive.dump:ro" postgres:16-alpine \
  pg_restore --list /restore/archive.dump | less
```

Use the exact archive path selected for the incident; do not restore a dump
from another host or database name without an explicit operator decision.

## Restore James

1. Stop James so it cannot write while the database is replaced:

   ```sh
   docker stop james-prod-app
   ```

2. Recreate the James database inside its existing Postgres container. The
   container's `POSTGRES_USER` and `POSTGRES_DB` values must match the values
   in the host `.env` variables `JAMES_POSTGRES_USER` and `JAMES_POSTGRES_DB`.

   ```sh
   docker exec james-prod-postgres sh -eu -c \
     'dropdb --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB" &&
      createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
   ```

3. Stream the gzip-free custom archive into `pg_restore`. `--clean` is not
   needed after the database recreation, which avoids leaving objects that are
   absent from the archive.

   ```sh
   docker exec -i james-prod-postgres pg_restore \
     --exit-on-error --no-owner --no-privileges \
     --username "$JAMES_POSTGRES_USER" \
     --dbname "$JAMES_POSTGRES_DB" < "$JAMES_ARCHIVE"
   ```

4. Start James and verify its own IMAP/JMAP/SMTP health before allowing the
   calendar smoke test to exercise IMAP authentication:

   ```sh
   docker start james-prod-app
   docker ps --filter name=james-prod-app
   ```

## Restore Davis PostgreSQL

1. Stop the Davis writers while leaving its database container available:

   ```sh
   docker compose stop davis davis-web
   ```

2. Recreate the Davis database using the database container's initialized
   superuser. The database and user must match `DAVIS_POSTGRES_DB` and
   `DAVIS_POSTGRES_USER` from `.env`.

   ```sh
   docker exec davis-postgres sh -eu -c \
     'dropdb --if-exists -U "$POSTGRES_USER" "$POSTGRES_DB" &&
      createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
   ```

3. Restore the custom archive:

   ```sh
   docker exec -i davis-postgres pg_restore \
     --exit-on-error --no-owner --no-privileges \
     --username "$DAVIS_POSTGRES_BACKUP_USER" \
     --dbname "$DAVIS_POSTGRES_BACKUP_DB" < "$DAVIS_ARCHIVE"
   ```

4. Start Davis, apply any migrations included by the pinned image, and then
   run the authenticated smoke test:

   ```sh
   docker compose up -d davis davis-web
   docker compose exec -T davis sh -c \
     'APP_ENV=prod bin/console doctrine:migrations:migrate --no-interaction'
   ./scripts/smoke.sh https://calendar.unicorncommander.ai \
     user@example.com /secure/path/to/password-file
   ```

## Restore the MariaDB fallback

If `docker-compose.mariadb.yml` is active, Davis archives are plain, gzip-free
SQL files named with a `.sql` suffix because `pg_dump -Fc` cannot read
MariaDB. Set `DAVIS_DATABASE_ENGINE=mariadb` before running `backup.sh`.

```sh
DAVIS_ARCHIVE="/home/deploy/backups/mail-calendar/${BACKUP_HOST}_${DAVIS_POSTGRES_BACKUP_DB}_YYYYMMDDTHHMMSSZ.sql"
docker compose -f docker-compose.yml -f docker-compose.mariadb.yml stop davis davis-web
docker exec -i davis-postgres sh -eu -c \
  'mariadb --user=root --password="$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' \
  < "$DAVIS_ARCHIVE"
docker compose -f docker-compose.yml -f docker-compose.mariadb.yml up -d davis davis-web
```

The SQL archive contains its own database statements from `mariadb-dump`; if a
restore requires a clean database, use the MariaDB client inside the container
to drop/recreate `${MARIADB_DATABASE}` first, then replay the archive.
