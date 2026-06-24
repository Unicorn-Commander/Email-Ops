/**
 * Provisioning approval-queue REST surface.
 *
 *   GET  workspaces/:workspaceId/provisioning-requests?state=PENDING
 *   POST workspaces/:workspaceId/provisioning-requests/:id/approve
 *   POST workspaces/:workspaceId/provisioning-requests/:id/reject     ({ note? })
 *
 * JWT + membership guarded; approve/reject are gated at the policy's
 * approverMinRole inside the service.
 */

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ProvisioningRequestState, User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ProvisioningRequestsService } from './provisioning-requests.service';

class RejectDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@ApiTags('provisioning')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/provisioning-requests')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class ProvisioningRequestsController {
  constructor(private readonly requests: ProvisioningRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'List provisioning requests (optionally by state).' })
  @ApiResponse({ status: 200, description: 'The requests + count.' })
  async list(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query('state') stateRaw?: string,
  ) {
    const state =
      stateRaw && (Object.values(ProvisioningRequestState) as string[]).includes(stateRaw)
        ? (stateRaw as ProvisioningRequestState)
        : undefined;
    const items = await this.requests.list(workspaceId, ucUidOf(user as WithWorkspaceClaim), state);
    return { items, count: items.length };
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a request — replay it through the canonical apply path.' })
  @ApiResponse({ status: 201, description: 'The applied (or failed) request.' })
  @ApiResponse({ status: 403, description: 'Below the policy approverMinRole.' })
  async approve(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
  ) {
    return this.requests.approve(workspaceId, ucUidOf(user as WithWorkspaceClaim), role, id);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a request (no apply).' })
  @ApiResponse({ status: 201, description: 'The rejected request.' })
  @ApiResponse({ status: 403, description: 'Below the policy approverMinRole.' })
  async reject(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
    @Body() body: RejectDto,
  ) {
    return this.requests.reject(workspaceId, ucUidOf(user as WithWorkspaceClaim), role, id, body.note);
  }
}
