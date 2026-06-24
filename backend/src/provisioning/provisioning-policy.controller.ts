/**
 * Provisioning-policy REST surface.
 *
 *   GET workspaces/:workspaceId/provisioning-policy   → the effective policy
 *   PUT workspaces/:workspaceId/provisioning-policy    (ADMIN+ only)
 *
 * JWT + membership guarded. Reading the policy is member-level; editing the
 * control surface that gates everything is itself gated near the top (ADMIN+).
 */

import { Body, Controller, ForbiddenException, Get, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, Min } from 'class-validator';
import { ProvisioningMode, User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { roleAtLeast } from '../common/workspace/role-rank';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ProvisioningPolicyService } from './provisioning-policy.service';
import { UpdatePolicyInput } from './provisioning.types';

class UpdatePolicyDto {
  @IsOptional() @IsEnum(ProvisioningMode) human_mailbox_create_mode?: ProvisioningMode;
  @IsOptional() @IsEnum(ProvisioningMode) human_mailbox_edit_mode?: ProvisioningMode;
  @IsOptional() @IsEnum(ProvisioningMode) agent_mailbox_create_mode?: ProvisioningMode;
  @IsOptional() @IsEnum(ProvisioningMode) agent_mailbox_edit_mode?: ProvisioningMode;
  @IsOptional() @IsEnum(ProvisioningMode) agent_create_mode?: ProvisioningMode;
  @IsOptional() @IsEnum(ProvisioningMode) agent_edit_mode?: ProvisioningMode;
  @IsOptional() @IsEnum(WorkspaceRole) approver_min_role?: WorkspaceRole;
  @IsOptional() @IsBoolean() allow_self_service_own_mailbox?: boolean;
  @IsOptional() @IsInt() @Min(0) max_mailboxes_per_workspace?: number;
  @IsOptional() @IsInt() @Min(0) max_agents_per_workspace?: number;
}

@ApiTags('provisioning')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/provisioning-policy')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class ProvisioningPolicyController {
  constructor(private readonly policy: ProvisioningPolicyService) {}

  @Get()
  @ApiOperation({ summary: 'Read the workspace provisioning policy (who may create mailboxes/agents).' })
  @ApiResponse({ status: 200, description: 'The effective policy (a row, or the Balanced default).' })
  async get(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    return this.policy.getView(workspaceId, ucUidOf(user as WithWorkspaceClaim));
  }

  @Put()
  @ApiOperation({ summary: 'Update the workspace provisioning policy (ADMIN+ only).' })
  @ApiResponse({ status: 200, description: 'The updated policy.' })
  @ApiResponse({ status: 403, description: 'Below ADMIN — cannot edit the policy.' })
  async update(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Body() body: UpdatePolicyDto,
  ) {
    if (!roleAtLeast(role, WorkspaceRole.ADMIN)) {
      throw new ForbiddenException('Editing the provisioning policy requires ADMIN.');
    }
    const patch: UpdatePolicyInput = {};
    if (body.human_mailbox_create_mode !== undefined) patch.humanMailboxCreateMode = body.human_mailbox_create_mode;
    if (body.human_mailbox_edit_mode !== undefined) patch.humanMailboxEditMode = body.human_mailbox_edit_mode;
    if (body.agent_mailbox_create_mode !== undefined) patch.agentMailboxCreateMode = body.agent_mailbox_create_mode;
    if (body.agent_mailbox_edit_mode !== undefined) patch.agentMailboxEditMode = body.agent_mailbox_edit_mode;
    if (body.agent_create_mode !== undefined) patch.agentCreateMode = body.agent_create_mode;
    if (body.agent_edit_mode !== undefined) patch.agentEditMode = body.agent_edit_mode;
    if (body.approver_min_role !== undefined) patch.approverMinRole = body.approver_min_role;
    if (body.allow_self_service_own_mailbox !== undefined)
      patch.allowSelfServiceOwnMailbox = body.allow_self_service_own_mailbox;
    if (body.max_mailboxes_per_workspace !== undefined)
      patch.maxMailboxesPerWorkspace = body.max_mailboxes_per_workspace;
    if (body.max_agents_per_workspace !== undefined)
      patch.maxAgentsPerWorkspace = body.max_agents_per_workspace;
    return this.policy.setPolicy(workspaceId, ucUidOf(user as WithWorkspaceClaim), patch);
  }
}
