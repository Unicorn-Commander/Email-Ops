import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { User } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { MembershipService } from '../common/workspace/membership.service';
import { ExplicitCredentialGuard } from '../auth/guards/explicit-credential.guard';
import { assertHumanApproval } from './human-approval';
import { StandingApprovalsService, StandingRequest } from './standing-approvals.service';

export class StandingRequestDto implements StandingRequest {
  @IsString() @MaxLength(200) campaign_key!: string;
  @IsString() @MaxLength(200) mailbox_id!: string;
  @IsString() @MaxLength(100000) body_template!: string;
  @IsString() @MaxLength(500) subject!: string;
  @IsOptional() @IsObject() placeholder_rules?: Record<string, string>;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsInt({ each: true })
  @Min(0, { each: true })
  optional_lines?: number[];
  @IsInt() @Min(1) @Max(100000) cap_per_day!: number;
  @IsISO8601() expires_at!: string;
  @IsOptional() @IsObject() recipient_rules?: Record<string, unknown>;
}
export class StandingApproveDto {
  @IsString() @Matches(/^[0-9a-f]{64}$/) definition_sha256!: string;
}

@Controller('workspaces/:workspaceId/standing-approvals')
@UseGuards(ExplicitCredentialGuard, WorkspaceMembershipGuard)
export class StandingApprovalsController {
  constructor(
    private readonly standing: StandingApprovalsService,
    private readonly membership: MembershipService,
  ) {}

  private async authorize(user: User, workspaceId: string) {
    assertHumanApproval(user);
    await this.membership.assertCanReviewInbox(user, workspaceId);
  }

  @Get()
  async list(@ResolvedWorkspace() ws: string, @CurrentUser() user: User) {
    await this.authorize(user, ws);
    return { items: await this.standing.list(ws, user) };
  }

  @Post()
  async request(
    @ResolvedWorkspace() ws: string,
    @CurrentUser() user: User,
    @Body() body: StandingRequestDto,
  ) {
    await this.authorize(user, ws);
    return this.standing.request(ws, user, body);
  }

  @Post(':id/approve')
  async approve(
    @ResolvedWorkspace() ws: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: StandingApproveDto,
  ) {
    await this.authorize(user, ws);
    return this.standing.approve(ws, user, id, body.definition_sha256);
  }

  @Post(':id/revoke')
  async revoke(
    @ResolvedWorkspace() ws: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    await this.authorize(user, ws);
    return this.standing.revoke(ws, user, id);
  }
}
