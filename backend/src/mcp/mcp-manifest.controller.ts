/**
 * Per-environment Brigade federation manifest — the PUBLIC discovery route.
 *
 * THE BUG THIS FIXES: frontend/public/.well-known/mcps.json hardcodes
 * `mcp_endpoint: https://email-ops.magicunicorn.dev/api/v1/mcp` and BOTH the prod
 * and dogfood frontends serve that same static file — so PROD advertised the
 * DOGFOOD MCP endpoint and federated agents to the wrong stack.
 *
 * THE FIX: the backend serves the manifest with `mcp_endpoint` derived per
 * environment. The catalog itself (tools/auth/etc.) comes from the bundled
 * MCP_MANIFEST_CATALOG (a copy of the static file, kept in sync by the drift
 * spec); only `mcp_endpoint` is rewritten per request:
 *   - PUBLIC_BASE_URL env when set (explicit override per stack), else
 *   - the request's own scheme+host — which is correct per-stack because main.ts
 *     sets `trust proxy`, so req.protocol/host reflect the real external host
 *     Traefik forwarded (prod host on prod, dogfood host on dogfood). So this is
 *     correct with ZERO env configuration.
 *
 * ROUTING: Traefik sends non-`/api` traffic to the FRONTEND, and the root
 * `.well-known/*` paths are excluded from the global prefix in main.ts (which we
 * do not own here). So this route lives UNDER the `/api/v1` prefix — guaranteed to
 * reach the backend — at two aliases:
 *   GET /api/v1/mcp/manifest
 *   GET /api/v1/.well-known/mcps.json
 * Point the Brigade federation registration at one of these (deploy caveat: the
 * canonical root `/.well-known/mcps.json` is still the frontend static copy until
 * Traefik/main.ts route it here).
 *
 * PUBLIC (no JWT): discovery must be fetchable by the federation gateway. The
 * global ThrottlerGuard still applies. Degrade-clean: never 500s the discovery
 * route.
 */

import { Controller, Get, Logger, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MCP_MANIFEST_CATALOG } from './mcp-manifest.catalog';

@ApiTags('mcp')
@Controller()
export class McpManifestController {
  private readonly logger = new Logger(McpManifestController.name);

  @Get('mcp/manifest')
  @ApiOperation({
    summary:
      'Per-environment Brigade federation manifest (mcp_endpoint derived from the host / PUBLIC_BASE_URL).',
  })
  manifest(@Req() req: Request, @Res() res: Response): void {
    this.serve(req, res);
  }

  /** Alias mirroring the canonical well-known name (under the /api/v1 prefix). */
  @Get('.well-known/mcps.json')
  @ApiOperation({ summary: 'Per-environment federation manifest (well-known alias).' })
  wellKnown(@Req() req: Request, @Res() res: Response): void {
    this.serve(req, res);
  }

  private serve(req: Request, res: Response): void {
    // Deep-clone so we never mutate the shared, bundled catalog constant.
    const manifest = JSON.parse(JSON.stringify(MCP_MANIFEST_CATALOG)) as Record<string, unknown>;
    try {
      manifest.mcp_endpoint = this.resolveMcpEndpoint(req);
    } catch (err) {
      // Never fail discovery: fall back to the static catalog's own endpoint.
      this.logger.warn(`manifest endpoint resolve failed, serving bundled default: ${(err as Error).message}`);
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    // Per-environment payload — a shared cache must not pin one stack's host.
    res.set('Cache-Control', 'no-store');
    res.status(200).send(JSON.stringify(manifest, null, 2));
  }

  /** `${base}/${API_PREFIX}/mcp` — base from PUBLIC_BASE_URL or the (proxied) request host. */
  private resolveMcpEndpoint(req: Request): string {
    const prefix = (process.env.API_PREFIX || 'api/v1').replace(/^\/+|\/+$/g, '');
    return `${this.publicBaseUrl(req)}/${prefix}/mcp`;
  }

  private publicBaseUrl(req: Request): string {
    const override = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (override) return override;
    // main.ts sets `trust proxy`, so these reflect the X-Forwarded-* real host.
    const proto = (req.protocol || 'https').replace(/[^a-z]/gi, '') || 'https';
    const host = req.get('host');
    if (host) return `${proto}://${host}`;
    // Last-resort fallback to the catalog's own (static) endpoint origin.
    const staticEndpoint = String(MCP_MANIFEST_CATALOG.mcp_endpoint ?? '');
    const m = staticEndpoint.match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : 'https://email-ops.magicunicorn.dev';
  }
}
