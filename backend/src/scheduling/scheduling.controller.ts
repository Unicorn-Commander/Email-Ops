import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { SchedulingService } from './scheduling.service';
import { ScheduledSendPayload } from './scheduling.types';

class SnoozeDto {
  @IsISO8601() until!: string;
  // The reader passes the thread subject so the Snoozed view renders a human row;
  // absent (e.g. an agent caller) → the service resolves it best-effort.
  @IsOptional() @IsString() @MaxLength(300) subject?: string;
}

class ScheduleSendDto {
  @IsString() @MaxLength(2000) to_address!: string;
  @IsOptional() @IsString() @MaxLength(300) subject?: string;
  @IsOptional() @IsString() @MaxLength(50000) body?: string;
  @IsOptional() @IsString() @MaxLength(100000) body_html?: string;
  @IsISO8601() send_at!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) to_addresses?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) cc?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) bcc?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) attachments?: { blob_id: string; name: string; type: string }[];
  @IsOptional() @IsString() @MaxLength(500) in_reply_to_thread_id?: string;
  @IsOptional() @IsString() @MaxLength(500) in_reply_to?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) references?: string[];
  @IsOptional() @IsString() @MaxLength(500) draft_id?: string;
}

function parseDate(raw: string, field: string): Date {
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${field} must be a valid ISO datetime.`);
  return date;
}

function schedulePayload(body: ScheduleSendDto): ScheduledSendPayload {
  const toAddress = body.to_address.trim();
  if (!toAddress) throw new BadRequestException('to_address is required.');
  const toAddresses = body.to_addresses?.map((a) => a.trim()).filter(Boolean);
  return {
    toAddress,
    toAddresses: toAddresses?.length ? toAddresses : undefined,
    subject: body.subject ?? '',
    body: body.body ?? '',
    bodyHtml: body.body_html ?? null,
    cc: body.cc?.length ? body.cc : undefined,
    bcc: body.bcc?.length ? body.bcc : undefined,
    attachments: body.attachments?.length ? body.attachments : undefined,
    inReplyToThreadId: body.in_reply_to_thread_id ?? null,
    inReplyToMessageId: body.in_reply_to ?? null,
    references: body.references?.length ? body.references : undefined,
    draftId: body.draft_id ?? null,
  };
}

@ApiTags('mail')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mail')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

  @Put(':mailboxId/threads/:threadId/snooze')
  @ApiOperation({ summary: 'Snooze a sovereign mailbox thread until a chosen time.' })
  @ApiResponse({ status: 200, description: '{ snoozed, item } — false when dormant/external/refused.' })
  async snoozeThread(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('threadId') threadId: string,
    @Body() body: SnoozeDto,
  ) {
    return this.scheduling.snoozeThread(user, {
      workspaceId,
      mailboxId,
      threadId,
      until: parseDate(body.until, 'until'),
      subject: body.subject ?? null,
    });
  }

  @Delete(':mailboxId/threads/:threadId/snooze')
  @ApiOperation({ summary: 'Cancel an active snooze and restore the thread to Inbox.' })
  async unsnoozeThread(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('threadId') threadId: string,
  ) {
    return this.scheduling.unsnoozeThread(user, { workspaceId, mailboxId, threadId });
  }

  @Get(':mailboxId/snoozed')
  @ApiOperation({ summary: 'List active snoozed threads for one sovereign mailbox.' })
  async listSnoozed(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
  ) {
    const snoozed = await this.scheduling.listSnoozed(user, workspaceId, mailboxId);
    return { snoozed, count: snoozed.length };
  }

  @Post(':mailboxId/scheduled-sends')
  @ApiOperation({ summary: 'Schedule an outbound email to send later from one sovereign mailbox.' })
  @ApiResponse({ status: 201, description: '{ scheduled, item } — false when dormant/external/refused.' })
  async scheduleSend(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Body() body: ScheduleSendDto,
  ) {
    return this.scheduling.scheduleSend(user, {
      workspaceId,
      mailboxId,
      payload: schedulePayload(body),
      sendAt: parseDate(body.send_at, 'send_at'),
    });
  }

  @Delete(':mailboxId/scheduled-sends/:id')
  @ApiOperation({ summary: 'Cancel a pending scheduled send.' })
  async cancelScheduledSend(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    return this.scheduling.cancelScheduledSend(user, workspaceId, id);
  }

  @Get(':mailboxId/scheduled-sends')
  @ApiOperation({ summary: 'List pending scheduled sends for one sovereign mailbox.' })
  async listScheduledSends(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
  ) {
    const scheduled_sends = await this.scheduling.listScheduledSends(user, workspaceId, mailboxId);
    return { scheduled_sends, count: scheduled_sends.length };
  }

  @Get(':mailboxId/scheduled-sends/:id')
  @ApiOperation({
    summary:
      'Fetch one scheduled send in ANY state (the list hides sent/failed rows) — ' +
      'the undo-send bar polls this for a truthful sent/failed verdict.',
  })
  @ApiResponse({ status: 200, description: '{ item } — null when missing/foreign/dormant.' })
  async getScheduledSend(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('id') id: string,
  ) {
    const item = await this.scheduling.getScheduledSend(user, workspaceId, mailboxId, id);
    return { item };
  }
}
