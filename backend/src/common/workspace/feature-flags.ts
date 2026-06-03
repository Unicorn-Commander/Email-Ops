/**
 * Feature flags for Email-Ops.
 *
 * Every flag defaults to CURRENT behavior (SUITE-IDENTITY quality bar). The
 * helpers default-read process.env (which @nestjs/config populates from .env),
 * so the same helpers work in DI services and in the non-DI MCP tool layer.
 */

type EnvGetter = (key: string) => string | undefined;

const defaultGetter: EnvGetter = (k) => process.env[k];

function truthy(value: string | undefined | null, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const s = value.toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/**
 * Suite tenancy master switch (SUITE-IDENTITY).
 *
 * Default OFF == today's behavior: workspace routes do NOT require a
 * Membership row, the membership gate is a no-op, and rows resolve to
 * DEFAULT_WORKSPACE_ID. RLS exists in the DB but is inert because the runtime
 * still connects as the table owner.
 *
 * When ON (a later rollout phase, alongside flipping the runtime DATABASE_URL
 * to the NOBYPASSRLS email_ops_app role): workspace routes 403 without an
 * active Membership, and the membership-derived workspace drives the RLS GUC.
 */
export function tenancyEnabled(getEnv: EnvGetter = defaultGetter): boolean {
  return truthy(getEnv('EMAIL_OPS_TENANCY_ENABLED'), false);
}
