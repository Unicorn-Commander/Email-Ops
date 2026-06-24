/**
 * Email-Ops health REST surface (the email-steward report).
 *
 *   GET workspaces/:workspaceId/email-health
 *
 * Workspace-scoped, JWT + membership guarded (same pattern as agent-inbox /
 * agents). Read-only observability — no entitlement gate. Delegates to
 * EmailHealthService (the SAME report the MCP `email_ops_health` tool returns).
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { EmailHealthService } from './email-health.service';

@ApiTags('email-health')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/email-health')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class EmailHealthController {
  constructor(private readonly health: EmailHealthService) {}

  @Get()
  @ApiOperation({
    summary:
      'Email operations health + setup report for a workspace (mail engine, ' +
      'mailboxes, approval-queue backlog, recent send failures, agent fleet).',
  })
  @ApiResponse({ status: 200, description: 'The health report.' })
  async get(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    return this.health.getReport(workspaceId, ucUidOf(user as WithWorkspaceClaim));
  }
}
