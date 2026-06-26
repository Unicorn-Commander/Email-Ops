/**
 * The invitee-facing invitation surface.
 *
 *   GET  invites/mine            — the caller's pending invitations (by email)
 *   POST invites/accept (AcceptInviteDto) — accept by token → join the org
 *
 * Mounted at its OWN top-level prefix (NOT under workspaces/:workspaceId) so the
 * accept-by-token + list-mine paths — which span workspace boundaries — never
 * collide with the membership-guarded workspace routes. JWT-guarded only: the
 * random token is the authorization for accept; list-mine is scoped to the
 * caller's own email.
 */

import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WorkspacesService } from './workspaces.service';

/** Body for accepting an invitation. */
class AcceptInviteDto {
  @IsString()
  @MinLength(1)
  token!: string;
}

@ApiTags('invites')
@ApiBearerAuth()
@Controller('invites')
@UseGuards(JwtAuthGuard)
export class InvitesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('mine')
  @ApiOperation({ summary: 'List the caller’s own pending invitations.' })
  @ApiResponse({ status: 200, description: 'The caller’s pending invitations + count.' })
  async mine(@CurrentUser() user: User) {
    const invites = await this.workspaces.listMyInvites(user);
    return { invites, count: invites.length };
  }

  @Post('accept')
  @ApiOperation({ summary: 'Accept an invitation by its token (join the organization).' })
  @ApiResponse({ status: 201, description: 'The joined organization.' })
  @ApiResponse({ status: 400, description: 'The invitation is invalid or expired.' })
  @ApiResponse({ status: 404, description: 'No such invitation.' })
  async accept(@CurrentUser() user: User, @Body() body: AcceptInviteDto) {
    const workspace = await this.workspaces.acceptInvite(user, body.token);
    return { workspace };
  }
}
