-- agent_send_kits is created by the migration role (ADMIN_DATABASE_URL, email_ops_admin on the
-- dogfood ring). The schema's default privileges are defined FOR ROLE email_ops_owner only, so
-- the runtime role got no grant on the new table and every kit call failed with 42501
-- "permission denied for table agent_send_kits" (measured on dogfood 2026-10-05; CI runs as a
-- superuser and could not see it). Grant exactly what the sibling tables carry, and make tables
-- created later by the migration role inherit the same grants. Idempotent.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "agent_send_kits" TO email_ops_app;
GRANT SELECT ON TABLE "agent_send_kits" TO email_ops_ro;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'email_ops_admin') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE email_ops_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO email_ops_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE email_ops_admin IN SCHEMA public GRANT SELECT ON TABLES TO email_ops_ro';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE email_ops_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO email_ops_app';
  END IF;
END
$$;
