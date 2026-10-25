# Davis upstream PHPUnit gate

Run this Phase-1 gate against a throwaway PostgreSQL container before the
first deployment and before changing the Davis pin. The test source must be a
checkout of the exact Davis tag `v5.6.2`; this lane does not vendor or modify
the upstream source.

The released image is used as the PHP/runtime image, while the checked-out
source is mounted only into the throwaway test container. If the image being
tested does not contain Composer, use the same PHP-FPM image built from the
tag's `docker/Dockerfile` and keep the command unchanged.

```sh
set -eu

DAVIS_SOURCE=/tmp/davis-v5.6.2
TEST_NETWORK=davis-upstream-test
TEST_POSTGRES=davis-upstream-postgres
TEST_DB=davis_test
TEST_USER=davis_test
TEST_PASSWORD=phase1-only

docker network create "$TEST_NETWORK" 2>/dev/null || true
cleanup() {
  docker rm -f "$TEST_POSTGRES" >/dev/null 2>&1 || true
  docker network rm "$TEST_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$TEST_POSTGRES" --network "$TEST_NETWORK" \
  -e POSTGRES_DB="$TEST_DB" \
  -e POSTGRES_USER="$TEST_USER" \
  -e POSTGRES_PASSWORD="$TEST_PASSWORD" \
  postgres:16-alpine

until docker exec "$TEST_POSTGRES" pg_isready -U "$TEST_USER" -d "$TEST_DB"; do
  sleep 2
done

docker run --rm --network "$TEST_NETWORK" \
  -v "$DAVIS_SOURCE:/var/www/davis" \
  -w /var/www/davis \
  -e APP_ENV=test \
  -e APP_SECRET=phase1-only \
  -e DATABASE_DRIVER=postgresql \
  -e DATABASE_URL="postgresql://${TEST_USER}:${TEST_PASSWORD}@${TEST_POSTGRES}:5432/${TEST_DB}?serverVersion=16&charset=utf8" \
  ghcr.io/tchapi/davis:5.6.2 \
  sh -lc 'composer install --no-interaction --prefer-dist && bin/phpunit'
```

Pass criteria are a zero exit status and no test process left running. Record
the image digest, source tag, database image, and test output in the phase gate;
a successful `docker compose config -q` is not a substitute for this suite.

## Result 2026-10-25 (Persephone, your-mail-host, --cpus 1)

- Source `v5.6.2` (641f1db), image `ghcr.io/tchapi/davis:5.6.2@sha256:bb1060b14aba57efe4b4900bb2d29a927aea08e374d0637f63538a1f3ca14668`, `postgres:16-alpine`.
- `vendor/bin/phpunit --process-isolation` (as upstream CI runs it; `bin/phpunit` is a stale wrapper that fails with PHPUnit 10): **290 tests, 1342 assertions, 1 skipped, exit 0**, 9 min 20 s.
- Image tags on ghcr have no `v` prefix (`5.6.2`, not `v5.6.2`).
