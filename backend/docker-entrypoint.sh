#!/usr/bin/env sh
# Apply schema migrations, then boot the API. Migrations run as the DDL owner
# (ADMIN_DATABASE_URL) when provided, otherwise as the runtime role.
set -e

: "${DATABASE_URL:?DATABASE_URL is required}"
MIGRATE_URL="${ADMIN_DATABASE_URL:-$DATABASE_URL}"

echo "[email-ops] applying database migrations (prisma migrate deploy)..."
DATABASE_URL="$MIGRATE_URL" npx --no-install prisma migrate deploy

echo "[email-ops] starting backend on port ${PORT:-3231}..."
exec node dist/main
