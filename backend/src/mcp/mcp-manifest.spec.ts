import { readFileSync } from 'fs';
import { join } from 'path';
import { MCP_MANIFEST_CATALOG } from './mcp-manifest.catalog';

/**
 * Drift + validity guard for the Brigade federation manifest.
 *
 * Email-Ops advertises itself to the Brigade federation gateway via the public
 * `.well-known/mcps.json`. The gateway's validator (app/federation/manifest_schema.py
 * in the Brigade repo) is strict: top-level name/version/mcp_endpoint, a
 * tool_namespace matching ^[a-z0-9_]{6,12}$, auth.federated_auth with
 * expected_audience + signing_algorithm=="RS256", and per-tool
 * input_schema(dict) + scopes_required(list) + tier_required(free|pro|enterprise)
 * + read_only(bool). This test holds the static manifest to BOTH that shape AND
 * the live tool set (it must list exactly the tools mcp.service.ts registers), so
 * registration never fails validation and the catalog never drifts.
 */

const MANIFEST_PATH = join(__dirname, '../../../frontend/public/.well-known/mcps.json');
const MCP_SERVICE_PATH = join(__dirname, 'mcp.service.ts');
const NAMESPACE_RE = /^[a-z0-9_]{6,12}$/;
const TIERS = new Set(['free', 'pro', 'enterprise']);

/** Every tool name passed to `server.registerTool('name', …)` in mcp.service.ts. */
function registeredToolNames(): string[] {
  const src = readFileSync(MCP_SERVICE_PATH, 'utf8');
  const names = new Set<string>();
  const re = /registerTool\(\s*['"]([a-z0-9_]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return [...names].sort();
}

describe('Brigade federation manifest (.well-known/mcps.json)', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  it('matches the gateway manifest schema (namespace, endpoint, federated auth)', () => {
    expect(manifest.name).toBe('Email-Ops');
    expect(typeof manifest.version).toBe('string');
    expect(manifest.mcp_endpoint).toBe('https://email-ops.magicunicorn.dev/api/v1/mcp');
    // tool_namespace must satisfy the gateway regex (6-12 [a-z0-9_]); "email" (5) would 422.
    expect(manifest.tool_namespace).toMatch(NAMESPACE_RE);
    // The gateway validates auth.federated_auth, not auth.brigade_jwt.
    const fa = manifest.auth?.federated_auth;
    expect(fa?.expected_audience).toBe('email-ops'); // == the backend BRIGADE_EXPECTED_AUDIENCE
    expect(fa?.signing_algorithm).toBe('RS256'); // the gateway hard-rejects anything else
    expect(fa?.trusted_issuer).toBe('https://brigade.unicorncommander.ai');
  });

  it('lists EXACTLY the tools the MCP server registers (no drift)', () => {
    const manifestTools = (manifest.tools as { name: string }[]).map((t) => t.name).sort();
    expect(manifestTools).toEqual(registeredToolNames());
    expect(manifestTools).toEqual(
      expect.arrayContaining(['ui_navigate', 'ui_open_thread', 'ui_compose', 'ui_switch_space', 'ui_notify']),
    );
  });

  it('advertises the mail-rules tools with the scheduling tools’ scope register', () => {
    // list mirrors list_snoozed (read:email, read-only); create/update/delete
    // mirror snooze_thread / cancel_scheduled_send (write:mail, writes).
    const byName = new Map(
      (manifest.tools as { name: string; scopes_required: string[]; read_only: boolean }[]).map(
        (t) => [t.name, t],
      ),
    );
    expect(byName.get('list_mail_rules')).toMatchObject({
      scopes_required: ['read:email'],
      read_only: true,
    });
    for (const name of ['create_mail_rule', 'update_mail_rule', 'delete_mail_rule']) {
      expect(byName.get(name)).toMatchObject({
        scopes_required: ['write:mail'],
        read_only: false,
      });
    }
  });

  it('bundles a backend catalog copy that is identical to the static manifest (no drift)', () => {
    // The backend image ships only dist/ (no frontend static file), so the per-env
    // manifest route (mcp-manifest.controller.ts) serves the bundled
    // MCP_MANIFEST_CATALOG. It MUST stay byte-for-byte equivalent to the canonical
    // static manifest — the controller overrides ONLY mcp_endpoint at request time.
    expect(MCP_MANIFEST_CATALOG).toEqual(manifest);
  });

  it('gives every tool the per-tool fields the gateway validator requires', () => {
    for (const t of manifest.tools as Record<string, unknown>[]) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect((t.description as string).length).toBeGreaterThan(0);
      // input_schema must be an object (the gateway requires a dict).
      expect(t.input_schema && typeof t.input_schema === 'object' && !Array.isArray(t.input_schema)).toBe(true);
      expect(Array.isArray(t.scopes_required)).toBe(true);
      expect(TIERS.has(t.tier_required as string)).toBe(true);
      expect(typeof t.read_only).toBe('boolean');
    }
  });
});
