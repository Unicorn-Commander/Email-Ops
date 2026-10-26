import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { User } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { CalendarDevicesService } from './calendar-devices.service';

class CalendarDeviceCreateDto {
  @IsString() @MinLength(1) @MaxLength(320) mailboxId!: string;
  @IsString() @MinLength(1) @MaxLength(64) @Matches(/^[\x20-\x7e]+$/) label!: string;
}

class CalendarDeviceListQuery {
  @IsString() @MinLength(1) @MaxLength(320) mailboxId!: string;
}

function assertHumanRequest(request: Request): void {
  const user = request.user as
    | (User & { __patAuth?: unknown; __isFederationActor?: boolean })
    | undefined;
  if (!user || user.__patAuth || user.__isFederationActor) {
    throw new ForbiddenException('A human login is required to manage calendar device keys.');
  }
}

@ApiTags('calendar')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/calendar/devices')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class CalendarDevicesController {
  constructor(private readonly devices: CalendarDevicesService) {}

  @Get()
  @Throttle({ short: { ttl: 60_000, limit: 30 }, long: { ttl: 3_600_000, limit: 300 } })
  async list(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Req() request: Request,
    @Query() query: CalendarDeviceListQuery,
  ) {
    assertHumanRequest(request);
    const items = await this.devices.list(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      query.mailboxId,
    );
    return { items, count: items.length };
  }

  @Post()
  @Throttle({ short: { ttl: 60_000, limit: 5 }, long: { ttl: 3_600_000, limit: 30 } })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Req() request: Request,
    @Body() body: CalendarDeviceCreateDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    assertHumanRequest(request);
    return this.devices.create(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      user.id,
      body,
      idempotencyKey,
    );
  }

  @Delete(':id')
  @Throttle({ short: { ttl: 60_000, limit: 5 }, long: { ttl: 3_600_000, limit: 30 } })
  async revoke(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    assertHumanRequest(request);
    return this.devices.revoke(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      decodeURIComponent(id),
    );
  }
}
