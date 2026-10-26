import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { CalendarService } from './calendar.service';

class CalendarMailboxQuery {
  @IsString() mailbox_id!: string;
}

class CalendarRangeQuery extends CalendarMailboxQuery {
  @IsString() calendar_id!: string;
  @IsISO8601() start!: string;
  @IsISO8601() end!: string;
  @IsOptional() @IsString() timezone?: string;
}

class CalendarEventDto {
  @IsString() mailbox_id!: string;
  @IsString() calendar_id!: string;
  @IsString() @MaxLength(500) summary!: string;
  @IsString() start!: string;
  @IsString() end!: string;
  @IsOptional() @IsBoolean() all_day?: boolean;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() @MaxLength(100000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) location?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) recurrence_rule?: string | null;
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(320, { each: true }) attendees?: string[];
  @IsOptional() @IsString() @MaxLength(320) organizer?: string | null;
  @IsOptional() @IsString() @MaxLength(40) status?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) url?: string | null;
  @IsOptional() @IsString() uid?: string;
}

class CalendarUpdateDto extends CalendarEventDto {
  @IsOptional() @IsString() etag?: string | null;
}

class CalendarDeleteQuery extends CalendarMailboxQuery {
  @IsString() calendar_id!: string;
  @IsOptional() @IsString() etag?: string;
}

class FreeTimeQuery extends CalendarRangeQuery {
  @IsInt() @Min(5) @Max(1440) duration_minutes!: number;
  @IsOptional() @IsString() workday_start?: string;
  @IsOptional() @IsString() workday_end?: string;
  @IsOptional() @IsInt() @Min(1) @Max(20) limit?: number;
}

@ApiTags('calendar')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/calendar')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('calendars')
  async listCalendars(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query() query: CalendarMailboxQuery,
  ) {
    const items = await this.calendar.listCalendars(workspaceId, ucUidOf(user as WithWorkspaceClaim), query.mailbox_id);
    return { items, count: items.length };
  }

  @Get('events')
  async listEvents(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query() query: CalendarRangeQuery,
  ) {
    const items = await this.calendar.listEvents(workspaceId, ucUidOf(user as WithWorkspaceClaim), query);
    return { items, count: items.length };
  }

  @Get('free-busy')
  async freeBusy(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query() query: CalendarRangeQuery,
  ) {
    return this.calendar.freeBusy(workspaceId, ucUidOf(user as WithWorkspaceClaim), query);
  }

  @Get('find-free-time')
  async findFreeTime(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query() query: FreeTimeQuery,
  ) {
    return this.calendar.findFreeTime(workspaceId, ucUidOf(user as WithWorkspaceClaim), query);
  }

  @Post('events')
  async createEvent(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: CalendarEventDto,
  ) {
    return this.calendar.createEvent(workspaceId, ucUidOf(user as WithWorkspaceClaim), body);
  }

  @Patch('events/:eventId')
  async updateEvent(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('eventId') eventId: string,
    @Body() body: CalendarUpdateDto,
  ) {
    return this.calendar.updateEvent(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      ...body,
      event_id: decodeURIComponent(eventId),
    });
  }

  @Delete('events/:eventId')
  async deleteEvent(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('eventId') eventId: string,
    @Query() query: CalendarDeleteQuery,
  ) {
    return this.calendar.deleteEvent(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      mailbox_id: query.mailbox_id,
      calendar_id: query.calendar_id,
      event_id: decodeURIComponent(eventId),
      etag: query.etag,
    });
  }
}
