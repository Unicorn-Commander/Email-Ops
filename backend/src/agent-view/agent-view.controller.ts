import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AgentViewService } from './agent-view.service';

@ApiTags('agent-view')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/agents')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AgentViewController {
  constructor(private readonly agentView: AgentViewService) {}

  @Get('mailboxes')
  @ApiOperation({
    summary: 'Lightweight per-agent mailbox roster for the agent-world switcher.',
  })
  @ApiResponse({ status: 200, description: 'Every agent with mailbox address, unread count, and pending count.' })
  async roster(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    return this.agentView.listAgentMailboxes(user, workspaceId);
  }

  @Get(':agentId/mailbox')
  @ApiOperation({
    summary: "One agent's mailbox world: mailbox, recent threads, approval queue, and stats.",
  })
  @ApiResponse({ status: 200, description: 'The composed agent mailbox view.' })
  @ApiResponse({ status: 404, description: 'No such agent in this workspace.' })
  async mailbox(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('agentId') agentId: string,
    @Query('thread_limit') threadLimitRaw?: string,
  ) {
    const view = await this.agentView.getAgentMailbox(user, {
      workspaceId,
      agentId,
      threadLimit: parseThreadLimit(threadLimitRaw),
    });
    if (!view) {
      throw new NotFoundException('Agent not found in this workspace.');
    }
    return view;
  }
}

function parseThreadLimit(raw?: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
