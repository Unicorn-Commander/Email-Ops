/**
 * The Spaces REST surface (the top-bar switcher + the manage panel).
 *
 *   GET    workspaces/:workspaceId/spaces
 *   POST   workspaces/:workspaceId/spaces                  (CreateSpaceDto)
 *   PATCH  workspaces/:workspaceId/spaces/:id              (UpdateSpaceDto)
 *   DELETE workspaces/:workspaceId/spaces/:id
 *   PUT    workspaces/:workspaceId/spaces/:id/mailboxes    (SetMailboxesDto)
 *   PUT    workspaces/:workspaceId/spaces/:id/agents       (SetAgentsDto)
 *
 * JWT + workspace-membership guarded (copied from mailbox-accounts / agents). No
 * provisioning gate — a Space is a lightweight personal/team VIEW, not a
 * high-trust mailbox/agent provisioning action. The owner fence for PERSONAL
 * spaces lives in the service. Delegates to SpacesService; every method runs
 * inside withWorkspace.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SpaceVisibility, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { SpacesService } from './spaces.service';
import { CreateSpaceInput, SpaceVisibilityWire, UpdateSpaceInput } from './spaces.types';

/** Map the lowercase wire visibility to the Prisma enum. */
function toEnum(v: SpaceVisibilityWire): SpaceVisibility {
  return v === 'team' ? SpaceVisibility.TEAM : SpaceVisibility.PERSONAL;
}

/** Body for POST (create). Snake_case keys (the wire vocabulary). */
class CreateSpaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsIn(['personal', 'team'])
  visibility?: SpaceVisibilityWire;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icon?: string;
}

/** Body for PATCH (partial). Omit a field to leave it; null clears color/icon. */
class UpdateSpaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  icon?: string | null;

  @IsOptional()
  @IsInt()
  sort_order?: number;

  @IsOptional()
  @IsIn(['personal', 'team'])
  visibility?: SpaceVisibilityWire;
}

/** Body for replacing a Space's mailbox set. */
class SetMailboxesDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  mailbox_ids!: string[];
}

/** Body for replacing a Space's agent set. */
class SetAgentsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  agent_ids!: string[];
}

@ApiTags('spaces')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/spaces')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class SpacesController {
  constructor(private readonly spaces: SpacesService) {}

  @Get()
  @ApiOperation({ summary: 'List the caller’s personal spaces + all team spaces.' })
  @ApiResponse({ status: 200, description: 'The spaces + count.' })
  async list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.spaces.listSpaces(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items, count: items.length };
  }

  @Post()
  @ApiOperation({ summary: 'Create a space (personal by default; team = shared).' })
  @ApiResponse({ status: 201, description: 'The created space.' })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: CreateSpaceDto,
  ) {
    const input: CreateSpaceInput = {
      name: body.name,
      visibility: body.visibility ? toEnum(body.visibility) : undefined,
      color: body.color ?? null,
      icon: body.icon ?? null,
    };
    return this.spaces.createSpace(workspaceId, ucUidOf(user as WithWorkspaceClaim), input);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename / recolor / reorder / re-scope a space.' })
  @ApiResponse({ status: 200, description: 'The updated space.' })
  @ApiResponse({ status: 403, description: 'Not the owner of this personal space.' })
  @ApiResponse({ status: 404, description: 'No such space in this workspace.' })
  async update(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: UpdateSpaceDto,
  ) {
    const patch: UpdateSpaceInput = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.color !== undefined) patch.color = body.color;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.sort_order !== undefined) patch.sortOrder = body.sort_order;
    if (body.visibility !== undefined) patch.visibility = toEnum(body.visibility);

    const updated = await this.spaces.updateSpace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
      patch,
    );
    if (!updated) {
      throw new NotFoundException('Space not found in this workspace.');
    }
    return updated;
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a space (owner-only for personal).' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  @ApiResponse({ status: 403, description: 'Not the owner of this personal space.' })
  @ApiResponse({ status: 404, description: 'No such space in this workspace.' })
  async remove(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const deleted = await this.spaces.deleteSpace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
    );
    if (!deleted) {
      throw new NotFoundException('Space not found in this workspace.');
    }
    return { deleted: true };
  }

  @Put(':id/mailboxes')
  @ApiOperation({ summary: "Replace the space's mailbox membership set." })
  @ApiResponse({ status: 200, description: 'The updated space.' })
  @ApiResponse({ status: 400, description: 'A mailbox id is not in this workspace.' })
  @ApiResponse({ status: 404, description: 'No such space in this workspace.' })
  async setMailboxes(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: SetMailboxesDto,
  ) {
    const updated = await this.spaces.setMailboxes(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
      body.mailbox_ids,
    );
    if (!updated) {
      throw new NotFoundException('Space not found in this workspace.');
    }
    return updated;
  }

  @Put(':id/agents')
  @ApiOperation({ summary: "Replace the space's agent membership set." })
  @ApiResponse({ status: 200, description: 'The updated space.' })
  @ApiResponse({ status: 400, description: 'An agent id is not in this workspace.' })
  @ApiResponse({ status: 404, description: 'No such space in this workspace.' })
  async setAgents(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: SetAgentsDto,
  ) {
    const updated = await this.spaces.setAgents(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
      body.agent_ids,
    );
    if (!updated) {
      throw new NotFoundException('Space not found in this workspace.');
    }
    return updated;
  }
}
