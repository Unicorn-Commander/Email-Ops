/**
 * Agent-controls REST surface — the kill switch + the activity feed.
 *
 *   GET  workspaces/:workspaceId/agent-controls          -> { agents_paused }
 *   PUT  workspaces/:workspaceId/agent-controls  { agents_paused }
 *   GET  workspaces/:workspaceId/agent-activity?limit=N  -> { items, count }
 *
 * Workspace-scoped, JWT + membership guarded (same pattern as agent-inbox /
 * agents / email-health). Delegates to AgentControlsService.
 */

import { Body, Controller, ForbiddenException, Get, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { roleAtLeast } from '../common/workspace/role-rank';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { AgentControlsService, parseWindowDays } from './agent-controls.service';

class SetControlsDto {
  @IsBoolean()
  agents_paused!: boolean;
}

@ApiTags('agent-controls')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AgentControlsController {
  constructor(private readonly controls: AgentControlsService) {}

  @Get('agent-controls')
  @ApiOperation({ summary: 'Read the workspace kill switch (are agents paused?).' })
  @ApiResponse({ status: 200, description: 'The kill-switch state.' })
  async getControls(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    return this.controls.getControls(workspaceId, ucUidOf(user as WithWorkspaceClaim));
  }

  @Put('agent-controls')
  @ApiOperation({
    summary:
      'Pause/resume all agents in the workspace. While paused, agent compose/send ' +
      'is refused (a human approving an already-staged draft still works).',
  })
  @ApiResponse({ status: 200, description: 'The new kill-switch state.' })
  async setControls(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Body() body: SetControlsDto,
  ) {
    // A domain-lead (MANAGER+) can stop a misbehaving fleet without an admin.
    if (!roleAtLeast(role, WorkspaceRole.MANAGER)) {
      throw new ForbiddenException('Pausing/resuming the agent fleet requires MANAGER or above.');
    }
    return this.controls.setControls(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      body.agents_paused,
    );
  }

  @Get('agent-activity')
  @ApiOperation({ summary: 'Recent agent-mail activity / audit feed (newest-first).' })
  @ApiResponse({ status: 200, description: 'The activity items + count.' })
  async listActivity(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) || 50 : 50;
    const items = await this.controls.listActivity(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      limit,
    );
    return { items, count: items.length };
  }

  @Get('agent-metrics')
  @ApiOperation({
    summary:
      'Real server-side rail metrics for the agent command center: triaged ' +
      '(threads an agent filed), sent (agent autonomous + approved sends), and ' +
      'awaiting (current pending approvals). Honest counts — no client-side ' +
      'proxy. `?window=7d` sets the lookback (default 7d, clamped 1–90d). ' +
      'Degrade-clean: zeros on no data, never 500.',
  })
  @ApiResponse({ status: 200, description: 'The metrics + the window in days.' })
  async getMetrics(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query('window') windowRaw?: string,
  ) {
    return this.controls.getMetrics(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      parseWindowDays(windowRaw),
    );
  }
}
