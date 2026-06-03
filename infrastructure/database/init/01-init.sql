-- Email-Ops — Database Initialization Script
-- Runs once on first postgres container start, as the superuser, BEFORE the
-- backend applies Prisma migrations. Prisma Migrate owns the actual schema +
-- RLS + grants (see backend/prisma/migrations). This file only enables shared
-- extensions, confirms the admin grant, and pre-creates the suite tenancy role
-- split so a brand-new node has the roles the runtime expects.
--
-- ROLLOUT NOTE: Phase 1 keeps the runtime connecting as email_ops_admin (the
-- object owner). The email_ops_app role created here is the NOBYPASSRLS runtime
-- role for a LATER phase; creating it now is additive and inert. The RLS
-- migration re-asserts these roles + their grants idempotently, so this block
-- and the migration cannot diverge.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Grants (idempotent; the admin user is created by the postgres image from
-- POSTGRES_USER, this just makes the privilege grants explicit).
GRANT ALL PRIVILEGES ON DATABASE emailops TO email_ops_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO email_ops_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO email_ops_admin;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO email_ops_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO email_ops_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO email_ops_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON FUNCTIONS TO email_ops_admin;

-- ---------------------------------------------------------------------------
-- Suite tenancy role split (SUITE-IDENTITY §D3). Cluster-global, guarded so
-- re-runs are free. Passwords are placeholders for fresh dev/CI nodes;
-- production rotates them out-of-band via ADMIN_DATABASE_URL. The
-- security-critical attribute is email_ops_app being NOBYPASSRLS.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_owner') THEN
    CREATE ROLE email_ops_owner NOLOGIN;
  END IF;
  ALTER ROLE email_ops_owner BYPASSRLS;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_app') THEN
    CREATE ROLE email_ops_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'change_me_app';
  END IF;
  ALTER ROLE email_ops_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_audit') THEN
    CREATE ROLE email_ops_audit LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'change_me_audit';
  END IF;
  ALTER ROLE email_ops_audit LOGIN NOSUPERUSER NOBYPASSRLS;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_ro') THEN
    CREATE ROLE email_ops_ro LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'change_me_ro';
  END IF;
  ALTER ROLE email_ops_ro LOGIN NOSUPERUSER NOBYPASSRLS;

  -- The migration runner (email_ops_admin) co-administers owned objects.
  GRANT email_ops_owner TO email_ops_admin;
END
$$;

GRANT USAGE ON SCHEMA public TO email_ops_app, email_ops_audit, email_ops_ro, email_ops_owner;

COMMENT ON DATABASE emailops IS 'Email-Ops — mailbox / thread surface + agent-inbox database';
