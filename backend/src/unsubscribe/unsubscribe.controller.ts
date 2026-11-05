import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Response } from 'express';
import { SuppressedRecipientReason, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { MembershipService } from '../common/workspace/membership.service';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { assertHumanApproval } from '../approvals/human-approval';
import { SuppressionService } from './suppression.service';

class SuppressionQueryDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsEnum(SuppressedRecipientReason) reason?: SuppressedRecipientReason;
}

class CreateSuppressionDto {
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class SweepBouncesDto {
  @IsOptional() @IsString() @MaxLength(200) mailbox_id?: string;
  @IsOptional() @IsInt() @Min(1) since_days?: number;
  @IsOptional() @IsBoolean() dry_run?: boolean;
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Unsubscribe link unavailable</title></head>
<body><h1>Unsubscribe link unavailable</h1><p>This link is no longer available.</p></body></html>`;

const CONFIRMATION_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Unsubscribe</title></head>
<body><h1>Unsubscribe</h1><p>Click the button to stop future campaign email to this address.</p>
<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit">Unsubscribe</button></form></body></html>`;

/** RFC 8058 public one-click endpoint. It intentionally has no identity/session guard. */
@ApiTags('unsubscribe')
@Controller('u')
@Throttle({
  short: { ttl: 60_000, limit: 5 },
  long: { ttl: 3_600_000, limit: 30 },
  ip: { ttl: 60_000, limit: 30 },
})
export class UnsubscribeController {
  constructor(private readonly suppressions: SuppressionService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  async page(@Param('token') token: string, @Res() response: Response): Promise<void> {
    try {
      await this.suppressions.assertPublicToken(token);
      response.status(200).type('html').send(CONFIRMATION_HTML);
    } catch (error) {
      if (error instanceof NotFoundException) {
        response.status(404).type('html').send(NOT_FOUND_HTML);
        return;
      }
      throw error;
    }
  }

  @Post(':token')
  @Header('Cache-Control', 'no-store')
  async oneClick(
    @Param('token') token: string,
    @Body() body: Record<string, unknown>,
    @Res() response: Response,
  ): Promise<void> {
    if (body?.['List-Unsubscribe'] !== 'One-Click') {
      throw new BadRequestException('List-Unsubscribe=One-Click is required.');
    }
    try {
      await this.suppressions.consumeOneClick(token);
      response.status(204).send();
    } catch (error) {
      if (error instanceof NotFoundException) {
        response.status(404).type('html').send(NOT_FOUND_HTML);
        return;
      }
      throw error;
    }
  }
}

/** Authenticated workspace suppression administration. */
@ApiTags('suppressions')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/suppressions')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class SuppressionController {
  constructor(
    private readonly suppressions: SuppressionService,
    private readonly membership: MembershipService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List this workspace suppression records.' })
  @ApiResponse({ status: 200, description: '{ items: SuppressionView[] }' })
  async list(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query() query: SuppressionQueryDto,
  ) {
    const items = await this.suppressions.list(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      email: query.email,
      reason: query.reason,
    });
    return { items, count: items.length };
  }

  @Post('sweep-bounces')
  @ApiOperation({ summary: 'Sweep recent sovereign mailbox messages for hard-bounce DSNs.' })
  @ApiResponse({
    status: 201,
    description: '{ scanned, hard_bounces, added, already_present, skipped_soft }',
  })
  async sweepBounces(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: SweepBouncesDto,
  ) {
    const authorizedWorkspace = await this.membership.assertCanReviewInbox(user, workspaceId);
    return this.suppressions.sweepHardBounces(authorizedWorkspace, {
      mailboxId: body.mailbox_id,
      sinceDays: body.since_days,
      dryRun: body.dry_run,
    });
  }

  @Post()
  @ApiOperation({ summary: 'Manually suppress a recipient in this workspace.' })
  @ApiResponse({ status: 201, description: 'The suppression record.' })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: CreateSuppressionDto,
  ) {
    await this.membership.assertCanReviewInbox(user, workspaceId);
    return this.suppressions.suppressManually(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      body.email,
      body.note ?? null,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a suppression; signed-in human only.' })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  async remove(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    assertHumanApproval(user);
    await this.membership.assertCanReviewInbox(user, workspaceId);
    const removed = await this.suppressions.remove(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
    );
    if (!removed) throw new NotFoundException('Suppression not found in this workspace.');
    return { ok: true };
  }
}
