/**
 * Shared integration-test database URL.
 *
 * The integration specs (the ones that construct a real `PrismaService` and hit
 * the "verify" Postgres) import this instead of hardcoding the connection
 * string, so CI can point them at a service container via `TEST_DATABASE_URL`
 * while local runs keep hitting the long-standing verify DB unchanged.
 *
 * The default preserves the historically hardcoded value verbatim, so an
 * existing local run (`docker` verify-pg on :55444) behaves exactly as before
 * when `TEST_DATABASE_URL` is not set.
 */
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://postgres:REMOVED@127.0.0.1:55444/emailops?schema=public';

/**
 * The integration DB URL: `TEST_DATABASE_URL` when set (CI), otherwise the
 * verify-DB default (local dev). Read once at module load.
 */
export const TEST_DATABASE_URL: string =
  process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
