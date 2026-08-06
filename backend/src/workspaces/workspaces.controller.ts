/**
 * The multi-org tenancy REST surface (the org switcher + members/invite panel).
 *
 *   POST   workspaces                                  (CreateOrgDto)  — create org
 *   GET    workspaces                                                  — my orgs (alias of /auth/me/workspaces)
 *   PATCH  workspaces/:workspaceId                     (RenameOrgDto)  — rename org        [ADMIN+]
 *   GET    workspaces/:workspaceId/members                            — roster            [member]
 *   PATCH  workspaces/:workspaceId/members/:userKey    (UpdateMemberDto) — role/status    [ADMIN+]
 *   DELETE workspaces/:workspaceId/members/:userKey                   — remove / leave    [ADMIN+ | self]
 *   GET    workspaces/:workspaceId/invites                            — pending invites   [ADMIN+]
 *   POST   workspaces/:workspaceId/invites             (InviteDto)     — invite by email  [ADMIN+]
 *   DELETE workspaces/:workspaceId/invites/:id                        — revoke            [ADMIN+]
 *
 * The class is JWT-guarded; create + list need only that (no workspace context).
 * The :workspaceId methods add the WorkspaceMembershipGuard. RBAC itself is
 * enforced in WorkspacesService against the caller's ACTUAL membership role, so
 * it holds regardless of the EMAIL_OPS_TENANCY_ENABLED flag.
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
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, Matches, MinLength } from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces } from '../common/workspace/list-my-workspaces';
import { WorkspacesService } from './workspaces.service';
import {
  MembershipStatusWire,
  UpdateMemberInput,
  WorkspaceRoleWire,
  roleFromWire,
  statusFromWire,
} from './workspaces.types';

const ROLE_VALUES: WorkspaceRoleWire[] = ['viewer', 'member', 'manager', 'admin', 'owner'];
const STATUS_VALUES: MembershipStatusWire[] = ['active', 'suspended', 'revoked'];

/** Body for POST workspaces (create org). */
class CreateOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  display_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(48)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug may contain only lowercase letters, digits, and hyphens.' })
  slug?: string;
}

/** Body for PATCH workspaces/:id (rename). */
class RenameOrgDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  display_name!: string;
}

/** Body for PATCH a member (role and/or status). */
class UpdateMemberDto {
  @IsOptional()
  @IsIn(ROLE_VALUES)
  role?: WorkspaceRoleWire;

  @IsOptional()
  @IsIn(STATUS_VALUES)
  status?: MembershipStatusWire;
}

/** Body for inviting an email into the org. */
class InviteDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @IsOptional()
  @IsIn(ROLE_VALUES)
  role?: WorkspaceRoleWire;
}

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly membership: MembershipService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a new organization (the caller becomes its owner).' })
  @ApiResponse({ status: 201, description: 'The created organization.' })
  async create(@CurrentUser() user: User, @Body() body: CreateOrgDto) {
    return this.workspaces.createOrg(user, { displayName: body.display_name, slug: body.slug });
  }

  @Get()
  @ApiOperation({ summary: 'List the organizations the caller belongs to.' })
  @ApiResponse({ status: 200, description: 'The caller’s organizations.' })
  async list(@CurrentUser() user: User) {
    return { workspaces: await listMyWorkspaces(this.membership, user) };
  }

  @Patch(':workspaceId')
  @UseGuards(WorkspaceMembershipGuard)
  @ApiOperation({ summary: 'Rename an organization.' })
  @ApiResponse({ status: 200, description: 'The updated organization.' })
  @ApiResponse({ status: 403, description: 'Requires the admin role or higher.' })
  async rename(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: RenameOrgDto,
  ) {
    return this.workspaces.renameOrg(workspaceId, user, body.display_name);
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceMembershipGuard)
  @ApiOperation({ summary: 'List the organization’s members.' })
  @ApiResponse({ status: 200, description: 'The members + count.' })
  @ApiResponse({ status: 403, description: 'Not a member of this organization.' })
  async members(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const members = await this.workspaces.listMembers(workspaceId, user);
    return { members, count: members.length };
  }

  @Patch(':workspaceId/members/:userKey')
  @UseGuards(WorkspaceMembershipGuard)
  @ApiOperation({ summary: 'Change a member’s role or status.' })
  @ApiResponse({ status: 200, description: 'The updated member.' })
  @ApiResponse({ status: 400, description: 'Would leave the org without an active owner.' })
  @ApiResponse({ status: 403, description: 'Insufficient role for this change.' })
  @ApiResponse({ status: 404, description: 'No such member in this organization.' })
  async updateMember(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('userKey') userKey: string,
    @Body() body: UpdateMemberDto,
  ) {
    const patch: UpdateMemberInput = {};
    if (body.role !== undefined) patch.role = roleFromWire(body.role);
    if (body.status !== undefined) patch.status = statusFromWire(body.status);
    const updated = await this.workspaces.updateMember(workspaceId, user, userKey, patch);
    if (!updated) throw new NotFoundException('No such member in this organization.');
    return updated;
  }

  @Delete(':workspaceId/members/:userKey')
  @UseGuards(WorkspaceMembershipGuard)
  @ApiOperation({ summary: 'Remove a member (or leave the organization).' })
  @ApiResponse({ status: 200, description: 'Removed.' })
  @ApiResponse({ status: 400, description: 'Would remove the last active owner.' })
  @ApiResponse({ status: 403, description: 'Insufficient role.' })
  @ApiResponse({ status: 404, description: 'No such member in this organization.' })
  async removeMember(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('userKey') userKey: string,
  ) {
    const removed = await this.workspaces.removeMember(workspaceId, user, userKey);
    if (!removed) throw new NotFoundException('No such member in this organization.');
    return { removed: true };
  }

  @Get(':workspaceId/invites')
  @UseGuards(WorkspaceMembershipGuard)
  @ApiOperation({ summary: 'List the organization’s pending invitations.' })
  @ApiResponse({ status: 200, description: 'The pending invitations + count.' })
  @ApiResponse({ status: 403, description: 'Requires the admin role or higher.' })
  async invites(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const invites = await this.workspaces.listInvites(workspaceId, user);
    return { invites, count: invites.length };
  }

  @Post(':workspaceId/invites')
  @UseGuards(WorkspaceMembershipGuard)
  @ApiOperation({ summary: 'Invite an email address into the organization.' })
  @ApiResponse({ status: 201, description: 'The created invitation.' })
  @ApiResponse({ status: 400, description: 'Already a member, or invalid email.' })
  @ApiResponse({ status: 403, description: 'Requires the admin role or higher.' })
  async invite(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: InviteDto,
  ) {
    return this.workspaces.invite(workspaceId, user, {
      email: body.email,
      role: body.role ? roleFromWire(body.role) : undefined,
    });
  }

  @Delete(':workspaceId/invites/:id')
  @UseGuards(WorkspaceMembershipGuard)
  @ApiOperation({ summary: 'Revoke a pending invitation.' })
  @ApiResponse({ status: 200, description: 'Revoked.' })
  @ApiResponse({ status: 403, description: 'Requires the admin role or higher.' })
  @ApiResponse({ status: 404, description: 'No such invitation in this organization.' })
  async revokeInvite(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const revoked = await this.workspaces.revokeInvite(workspaceId, user, id);
    if (!revoked) throw new NotFoundException('No such invitation in this organization.');
    return { revoked: true };
  }
}
