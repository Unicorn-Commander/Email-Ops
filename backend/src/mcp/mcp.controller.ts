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
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { McpService } from './mcp.service';
import { User } from '@prisma/client';

@ApiTags('mcp')
@ApiBearerAuth()
// The global ThrottlerModule (short: 20/60s, long: 200/hr — app.module) applies to
// this MCP HTTP surface: agents/federation calls are rate-limited like any other
// authenticated route. (Previously @SkipThrottle exempted it — a DoS/abuse gap.)
@Controller('mcp')
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly mcp: McpService) {}

  @All()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'MCP Streamable HTTP endpoint. Auth as an Email-Ops user; agent acts on their behalf.',
  })
  async handle(@Req() req: Request, @Res() res: Response) {
    const user = req.user as User | undefined;
    if (!user) {
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
