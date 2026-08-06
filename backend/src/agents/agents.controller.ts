/**
 * The agent-registry REST surface (the "Agents" view + autonomy dial + multi-mailbox).
 *
 *   GET    workspaces/:workspaceId/agents
 *   POST   workspaces/:workspaceId/agents                      (CreateAgentDto)
 *   GET    workspaces/:workspaceId/agents/:id
 *   PATCH  workspaces/:workspaceId/agents/:id                  (UpdateAgentDto)
 *   POST   workspaces/:workspaceId/agents/:id/mailboxes        (BindMailboxDto)
 *   DELETE workspaces/:workspaceId/agents/:id/mailboxes/:mailboxId
 *
 * JWT + workspace-membership guarded. No compose-entitlement gate (managing the
 * registry never sends mail). Role-based provisioning gating arrives in a later
 * slice (resolveWithRole + decideProvision). Delegates to AgentsService.
 */

import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AgentAutonomyLevel, AgentTier, MailboxAccessLevel, User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { ProvisionDecision } from '../provisioning/provisioning-policy';
import { AgentsService } from './agents.service';
import { BindMailboxInput, CreateAgentInput, UpdateAgentInput } from './agents.types';

/** Body for POST (create). Snake_case keys (the wire vocabulary). */
class CreateAgentDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{0,62}$/, {
    message: 'key must be a lowercase slug (a-z, 0-9, - or _), 1–63 chars.',
  })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  display_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Explicit avatar image URL (absolute or app-relative, e.g. /agent-avatars/perry.svg). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string;

  @IsOptional()
  @IsString()
  mailbox_account_id?: string;

  @IsOptional()
  @IsEnum(AgentAutonomyLevel)
  autonomy_level?: AgentAutonomyLevel;

  @IsOptional()
  @IsObject()
  recipient_policy?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(AgentTier)
  tier?: AgentTier;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  manager_agent_key?: string;
}

/** Body for PATCH (partial update). Omit a field to leave it; null clears a nullable one. */
class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  display_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  /** Explicit avatar image URL; null clears it (renderers fall back to placeholders). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  avatar_url?: string | null;

  @IsOptional()
  @IsString()
  mailbox_account_id?: string | null;

  @IsOptional()
  @IsEnum(AgentAutonomyLevel)
  autonomy_level?: AgentAutonomyLevel;

  @IsOptional()
  @IsObject()
  recipient_policy?: Record<string, unknown> | null;

  @IsOptional()
  @IsEnum(AgentTier)
  tier?: AgentTier;

  @IsOptional()
  @IsString()
  @MaxLength(63)
  manager_agent_key?: string | null;

  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** Body for binding a mailbox to an agent. */
class BindMailboxDto {
  @IsString()
  mailbox_account_id!: string;

  @IsOptional()
  @IsIn(['SEND', 'READ', 'BOTH'])
  access?: MailboxAccessLevel;

  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;
}

@ApiTags('agents')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/agents')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly policy: ProvisioningPolicyService,
  ) {}

  /** APPROVAL-mode has no queue yet (Slice 3c wires it) — block clearly for now. */
  private blockIfApprovalGated(decision: ProvisionDecision, action: string): void {
    if (decision === 'requires_approval') {
      throw new ForbiddenException(
        `"${action}" requires approval under this workspace's policy; the approval workflow is being enabled.`,
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'List the workspace’s registered agents (the fleet).' })
  @ApiResponse({ status: 200, description: 'The agents + count.' })
  async list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.agents.listAgents(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items, count: items.length };
  }

  @Post()
  @ApiOperation({ summary: 'Register a new agent (key + display name + autonomy + tier).' })
  @ApiResponse({ status: 201, description: 'The created agent.' })
  @ApiResponse({ status: 409, description: 'An agent with that key already exists here.' })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Body() body: CreateAgentDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const input: CreateAgentInput = {
      key: body.key,
      displayName: body.display_name,
      description: body.description ?? null,
      avatarUrl: body.avatar_url ?? null,
      mailboxAccountId: body.mailbox_account_id ?? null,
      autonomyLevel: body.autonomy_level,
      recipientPolicy: body.recipient_policy ?? null,
      tier: body.tier,
      managerAgentKey: body.manager_agent_key ?? null,
    };
    // Standing up an agent already wired to a send identity is the higher-trust
    // agentMailbox gate (ADMIN_ONLY by default) IN ADDITION to agent.create — so a
    // MANAGER can't bypass it by binding the mailbox at create time. authorize()
    // throws 403 on a hard deny; either gate requiring approval queues the create.
    const d1 = await this.policy.authorize(workspaceId, ucUid, role, 'agent.create');
    const d2 = input.mailboxAccountId
      ? await this.policy.authorize(workspaceId, ucUid, role, 'agentMailbox.edit')
      : 'allow';
    if (d1 === 'requires_approval' || d2 === 'requires_approval') {
      const filed = await this.policy.fileRequest(workspaceId, ucUid, {
        kind: 'AGENT',
        action: 'create',
        payload: input,
        summary: `Create agent ${body.key}`,
      });
      return { provisioning_request: filed };
    }
    // Enforce the per-workspace cap (soft quota; the policy persists it).
    const policy = await this.policy.getEffectivePolicy(workspaceId, ucUid);
    if (
      policy.maxAgentsPerWorkspace != null &&
      (await this.agents.countAgents(workspaceId, ucUid)) >= policy.maxAgentsPerWorkspace
    ) {
      throw new ConflictException(
        `This workspace has reached its agent limit (${policy.maxAgentsPerWorkspace}).`,
      );
    }
    return this.agents.createAgent(workspaceId, ucUid, input);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one agent by id (incl. its mailboxes + hierarchy).' })
  @ApiResponse({ status: 200, description: 'The agent.' })
  @ApiResponse({ status: 404, description: 'No such agent in this workspace.' })
  async get(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const agent = await this.agents.getAgent(workspaceId, ucUidOf(user as WithWorkspaceClaim), id);
    if (!agent) {
      throw new NotFoundException('Agent not found in this workspace.');
    }
    return agent;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an agent (mailbox, autonomy, tier, paused, active, ...).' })
  @ApiResponse({ status: 200, description: 'The updated agent.' })
  @ApiResponse({ status: 404, description: 'No such agent in this workspace.' })
  async update(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
    @Body() body: UpdateAgentDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const patch: UpdateAgentInput = {};
    if (body.display_name !== undefined) patch.displayName = body.display_name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.avatar_url !== undefined) patch.avatarUrl = body.avatar_url;
    if (body.mailbox_account_id !== undefined) patch.mailboxAccountId = body.mailbox_account_id;
    if (body.autonomy_level !== undefined) patch.autonomyLevel = body.autonomy_level;
    if (body.recipient_policy !== undefined) patch.recipientPolicy = body.recipient_policy;
    if (body.tier !== undefined) patch.tier = body.tier;
    if (body.manager_agent_key !== undefined) patch.managerAgentKey = body.manager_agent_key;
    if (body.paused !== undefined) patch.paused = body.paused;
    if (body.active !== undefined) patch.active = body.active;

    // agent.edit, plus the ADMIN_ONLY agentMailbox gate when the send identity is
    // being re-pointed (so PATCH can't bypass it). Either requiring approval queues
    // the edit (replayed via updateAgent on approve); a hard deny 403s here.
    const d1 = await this.policy.authorize(workspaceId, ucUid, role, 'agent.edit');
    const d2 =
      body.mailbox_account_id !== undefined
        ? await this.policy.authorize(workspaceId, ucUid, role, 'agentMailbox.edit')
        : 'allow';
    if (d1 === 'requires_approval' || d2 === 'requires_approval') {
      const filed = await this.policy.fileRequest(workspaceId, ucUid, {
        kind: 'AGENT',
        action: 'update',
        payload: { id, patch },
        summary: `Update agent ${id}`,
      });
      return { provisioning_request: filed };
    }

    const updated = await this.agents.updateAgent(workspaceId, ucUid, id, patch);
    if (!updated) {
      throw new NotFoundException('Agent not found in this workspace.');
    }
    return updated;
  }

  @Post(':id/mailboxes')
  @ApiOperation({
    summary:
      "Bind a mailbox to an agent (grant act-through access; optionally make it the agent's primary From).",
  })
  @ApiResponse({ status: 201, description: 'The updated agent (with its mailboxes).' })
  @ApiResponse({ status: 404, description: 'No such agent in this workspace.' })
  async bindMailbox(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
    @Body() body: BindMailboxDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    this.blockIfApprovalGated(
      await this.policy.authorize(workspaceId, ucUid, role, 'agentMailbox.edit'),
      'agentMailbox.edit',
    );
    const input: BindMailboxInput = {
      mailboxAccountId: body.mailbox_account_id,
      access: body.access,
      isPrimary: body.is_primary,
    };
    const updated = await this.agents.bindMailbox(workspaceId, ucUid, id, input);
    if (!updated) {
      throw new NotFoundException('Agent not found in this workspace.');
    }
    return updated;
  }

  @Delete(':id/mailboxes/:mailboxId')
  @ApiOperation({ summary: "Revoke an agent's access to a mailbox." })
  @ApiResponse({ status: 200, description: 'The updated agent.' })
  @ApiResponse({ status: 404, description: 'No such agent in this workspace.' })
  async unbindMailbox(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
    @Param('mailboxId') mailboxId: string,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    this.blockIfApprovalGated(
      await this.policy.authorize(workspaceId, ucUid, role, 'agentMailbox.edit'),
      'agentMailbox.edit',
    );
    const updated = await this.agents.unbindMailbox(workspaceId, ucUid, id, mailboxId);
    if (!updated) {
      throw new NotFoundException('Agent not found in this workspace.');
    }
    return updated;
  }
}
