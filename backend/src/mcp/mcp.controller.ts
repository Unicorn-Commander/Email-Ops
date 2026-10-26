/**
 * Streamable HTTP transport endpoint for the Email-Ops MCP server.
 *
 * Brigade (and any MCP client — including Customer-Ops federating us) sends
 * POST/GET/DELETE on /api/v1/mcp. We authenticate via JWT, mint a per-request
 * MCP server scoped to the user, and let the SDK transport handle the protocol
 * framing. Stateless: each request is its own session (the caller
 * re-authenticates per call).
 */

import { All, Controller, Logger, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { setMcpUnauthorizedHeader } from '../auth/oauth-discovery/mcp-auth-header';
import { McpService } from './mcp.service';
import { User } from '@prisma/client';

@ApiTags('mcp')
@ApiBearerAuth()
// MCP stays under the global throttler (SkipThrottle here was a DoS gap).
// Caps are PER CREDENTIAL (app.module credentialTracker), not shared NAT IP.
// A sweep of search_mail/get_thread is several POSTs in one second — 20/60s
// is the send-lane budget and is too tight for agent reads, so MCP gets a
// higher short/long pair. The per-IP ceiling (`ip`) still applies.
@Throttle({ short: { ttl: 60000, limit: 60 }, long: { ttl: 3600000, limit: 600 } })
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcp: McpService) {}

  @All()
  // No controller-level WorkspaceMembershipGuard: with no workspace in the request it authorizes against the
  // server's DEFAULT workspace, which 403s every OAuth user who is not a member there (i.e. every customer). Each
  // MCP tool already checks membership for its own workspace argument via MembershipService.
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'MCP Streamable HTTP endpoint. Auth as an Email-Ops user; agent acts on their behalf.',
  })
  async handle(@Req() req: Request, @Res() res: Response) {
    const user = req.user as User | undefined;
    if (!user) {
      setMcpUnauthorizedHeader(req, res);
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    // Lazy require: the SDK ships dual CJS/ESM; resolve only when MCP is called.
    const sdk = require('@modelcontextprotocol/sdk/server/streamableHttp.js'); // eslint-disable-line @typescript-eslint/no-var-requires
    const StreamableHTTPServerTransport = sdk.StreamableHTTPServerTransport;

    const transport = new StreamableHTTPServerTransport({
      // Stateless — no session ID assignment, MCP clients send their own.
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => undefined);
    });

    try {
      const server = await this.mcp.createServerForUser(user);
      await server.connect(transport);
      // body has already been parsed by express.json — pass it through.
      await transport.handleRequest(req, res, (req as any).body);
    } catch (err) {
      this.logger.error(`MCP request failed (user=${user.email}): ${(err as Error).message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'mcp_internal_error' });
      }
    }
  }
}
