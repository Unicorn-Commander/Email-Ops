/**
 * The agent-registry REST surface (the "Agents" view + autonomy dial).
 *
 * Path: workspaces/:workspaceId/agents — workspace-scoped, under the user-JWT
 * (JwtAuthGuard) + workspace-membership (WorkspaceMembershipGuard) guards, the
 * same auth pattern as the agent-inbox surface.
 *
 *   GET    workspaces/:workspaceId/agents
 *   POST   workspaces/:workspaceId/agents          (body: CreateAgentDto)
 *   GET    workspaces/:workspaceId/agents/:id
 *   PATCH  workspaces/:workspaceId/agents/:id       (body: UpdateAgentDto)
 *
 * No compose-entitlement gate (unlike agent-inbox approve): managing the registry
 * configures agents, it never sends mail. Every action delegates to AgentsService,
 * which owns the RLS write path. The wire is snake_case both directions.
 */

import {
  Body,
  Controller,
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
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AgentAutonomyLevel, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { AgentsService } from './agents.service';
import { CreateAgentInput, UpdateAgentInput } from './agents.types';

/** Body for POST (create). Snake_case keys (the wire vocabulary). */
class CreateAgentDto {
  // A stable provenance slug, unique per workspace (the draftedBy successor).
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

  @IsOptional()
  @IsString()
  mailbox_account_id?: string;

  @IsOptional()
  @IsEnum(AgentAutonomyLevel)
  autonomy_level?: AgentAutonomyLevel;

  @IsOptional()
  @IsObject()
  recipient_policy?: Record<string, unknown>;
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
  @IsBoolean()
  active?: boolean;
}

@ApiTags('agents')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/agents')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'List the workspace’s registered agents (the fleet).' })
  @ApiResponse({ status: 200, description: 'The agents + count.' })
  async list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.agents.listAgents(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items, count: items.length };
  }

  @Post()
  @ApiOperation({ summary: 'Register a new agent (key + display name + autonomy).' })
  @ApiResponse({ status: 201, description: 'The created agent.' })
  @ApiResponse({ status: 409, description: 'An agent with that key already exists here.' })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: CreateAgentDto,
  ) {
    const input: CreateAgentInput = {
      key: body.key,
      displayName: body.display_name,
      description: body.description ?? null,
      mailboxAccountId: body.mailbox_account_id ?? null,
      autonomyLevel: body.autonomy_level,
      recipientPolicy: body.recipient_policy ?? null,
    };
    return this.agents.createAgent(workspaceId, ucUidOf(user as WithWorkspaceClaim), input);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one agent by id.' })
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
  @ApiOperation({ summary: 'Update an agent (mailbox, autonomy, active, ...).' })
  @ApiResponse({ status: 200, description: 'The updated agent.' })
  @ApiResponse({ status: 404, description: 'No such agent in this workspace.' })
  async update(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: UpdateAgentDto,
  ) {
    const patch: UpdateAgentInput = {};
    if (body.display_name !== undefined) patch.displayName = body.display_name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.mailbox_account_id !== undefined) patch.mailboxAccountId = body.mailbox_account_id;
    if (body.autonomy_level !== undefined) patch.autonomyLevel = body.autonomy_level;
    if (body.recipient_policy !== undefined) patch.recipientPolicy = body.recipient_policy;
    if (body.active !== undefined) patch.active = body.active;

    const updated = await this.agents.updateAgent(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
      patch,
    );
    if (!updated) {
      throw new NotFoundException('Agent not found in this workspace.');
    }
    return updated;
  }
}
