/**
 * Workspace-scoped mail-domain registry and DNS verification surface.
 *
 *   GET  workspaces/:workspaceId/mail-domains
 *   GET  workspaces/:workspaceId/mail-domains/:id
 *   POST workspaces/:workspaceId/mail-domains/:id/verification
 *   POST workspaces/:workspaceId/mail-domains/:id/verification/check
 *
 * Reads are member-level. Starting and checking a verification challenge are
 * ADMIN/OWNER-only because verified domains change the send-kit trust boundary.
 */

import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { MailDomainService } from './mail-domain.service';

@ApiTags('mail-domains')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mail-domains')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class MailDomainController {
  constructor(private readonly domains: MailDomainService) {}

  @Get()
  @ApiOperation({ summary: 'List the workspace mail domains and verification state.' })
  async list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.domains.listDomainVerification(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
    );
    return { items, count: items.length };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one workspace mail domain and its verification state.' })
  @ApiResponse({ status: 404, description: 'No such mail domain in this workspace.' })
  async get(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    return this.domains.getDomainVerification(workspaceId, ucUidOf(user as WithWorkspaceClaim), id);
  }

  @Post(':id/verification')
  @ApiOperation({ summary: 'Generate the TXT challenge for a mail domain.' })
  @ApiResponse({ status: 201, description: '{ recordName, recordType, recordValue }' })
  async requestVerification(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
  ) {
    return this.domains.requestVerification(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      role,
      id,
    );
  }

  @Post(':id/verification/check')
  @ApiOperation({ summary: 'Resolve the TXT challenge and update verification state.' })
  @ApiResponse({ status: 200, description: 'The updated verification state.' })
  async checkVerification(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
  ) {
    return this.domains.checkVerification(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      role,
      id,
    );
  }
}
