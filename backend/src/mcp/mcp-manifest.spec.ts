import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Drift guard for the Brigade federation manifest.
 *
 * Email-Ops advertises itself to the Brigade federation gateway via the public
 * `.well-known/mcps.json` (the mcps-manifest-v1 schema): its MCP endpoint, the
 * `email` tool namespace, the Brigade-JWT auth descriptor, and the tool catalog.
 * The manifest is a STATIC file (served by the Next frontend at the spec root
 * URL), so this test keeps its tool list HONEST — it must list exactly the tools
 * the MCP server actually registers (parsed from mcp.service.ts), so the catalog
 * Brigade ingests never drifts from the live `tools/list`.
 */

const MANIFEST_PATH = join(__dirname, '../../../frontend/public/.well-known/mcps.json');
const MCP_SERVICE_PATH = join(__dirname, 'mcp.service.ts');

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

  it('declares the email namespace + the canonical MCP endpoint + Brigade audience', () => {
    expect(manifest.name).toBe('Email-Ops');
    expect(manifest.tool_namespace).toBe('email');
    expect(manifest.mcp_endpoint).toBe('https://email-ops.magicunicorn.dev/api/v1/mcp');
    // Must match the backend's BRIGADE_EXPECTED_AUDIENCE default — else a
    // Brigade-minted token is rejected by our JWT strategy.
    expect(manifest.auth.brigade_jwt.audience).toBe('email-ops');
    expect(manifest.auth.brigade_jwt.trusted_issuers).toContain('https://brigade.unicorncommander.ai');
  });

  it('lists EXACTLY the tools the MCP server registers (no drift)', () => {
    const manifestTools = (manifest.tools as { name: string }[]).map((t) => t.name).sort();
    const registered = registeredToolNames();
    expect(manifestTools).toEqual(registered);
    // Sanity: the Phase-C agent-controls-the-UI tools are advertised.
    expect(manifestTools).toEqual(
      expect.arrayContaining(['ui_navigate', 'ui_open_thread', 'ui_compose', 'ui_switch_space', 'ui_notify']),
    );
  });

  it('gives every advertised tool a description (the catalog Brigade rebroadcasts)', () => {
    for (const t of manifest.tools as { name: string; description?: string }[]) {
      expect(typeof t.description).toBe('string');
      expect((t.description ?? '').length).toBeGreaterThan(0);
    }
  });
});
