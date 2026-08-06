/**
 * The drain endpoint for the "agent controls the UI" channel.
 *
 *   GET workspaces/:workspaceId/ui-commands
 *
 * The user's cockpit polls this (focus-gated) to pull pending UI commands an
 * agent enqueued for it. JWT + workspace-membership guarded; drains for the
 * CALLER's ucUid only (the per-user fence on top of the workspace RLS fence).
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { UiCommandService } from './ui-commands.service';

@ApiTags('ui-commands')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/ui-commands')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class UiCommandsController {
  constructor(private readonly uiCommands: UiCommandService) {}

  @Get()
  @ApiOperation({ summary: 'Drain the caller’s pending agent-issued UI commands.' })
  @ApiResponse({ status: 200, description: 'The pending commands (marked consumed) + count.' })
  async drain(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const commands = await this.uiCommands.drain(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { commands, count: commands.length };
  }
}
