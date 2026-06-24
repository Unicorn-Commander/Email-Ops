/**
 * The human email-client BFF (read your inboxes + compose), distinct from the
 * agent-inbox approval surface.
 *
 *   GET  workspaces/:workspaceId/mail/:mailboxId/threads?limit=
 *   GET  workspaces/:workspaceId/mail/:mailboxId/threads/:threadId
 *   POST workspaces/:workspaceId/mail/:mailboxId/compose          (ComposeMailDto)
 *
 * JWT + membership guarded. Delegates to EmailService (the SoR + the mail-engine
 * seam) — so it's degrade-clean: reads return the SoR view while the engine is
 * dormant and light up with received mail when it's live; a compose is recorded
 * and queued to the engine (FAILED-clean if dormant). Sends as the chosen mailbox.
 */

import { randomUUID } from 'crypto';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { EmailService } from '../email/email.service';
import { ComposeInput, MailFolder } from '../email/email.types';

const MAIL_FOLDERS: MailFolder[] = ['inbox', 'archive', 'spam', 'trash', 'sent', 'drafts'];
function normalizeFolder(raw?: string): MailFolder {
  const f = (raw ?? '').toLowerCase() as MailFolder;
  return MAIL_FOLDERS.includes(f) ? f : 'inbox';
}

class ComposeMailDto {
  @IsEmail() to_address!: string;
  @IsOptional() @IsString() @MaxLength(300) subject?: string;
  @IsOptional() @IsString() @MaxLength(50000) body?: string;
  @IsOptional() @IsString() in_reply_to_thread_id?: string;
}

@ApiTags('mail')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mail')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class MailController {
  constructor(private readonly email: EmailService) {}

  @Get(':mailboxId/threads')
  @ApiOperation({ summary: "A mailbox's recent threads for a folder (the client inbox list)." })
  @ApiResponse({ status: 200, description: 'The threads + count + folder.' })
  async threads(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Query('limit') limitRaw?: string,
    @Query('folder') folderRaw?: string,
  ) {
    const limit = limitRaw ? Math.min(Number.parseInt(limitRaw, 10) || 50, 200) : 50;
    const folder = normalizeFolder(folderRaw);
    const threads = await this.email.listMailboxInbox(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      limit,
      folder,
    );
    return { threads, count: threads.length, folder };
  }

  @Get(':mailboxId/threads/:threadId')
  @ApiOperation({ summary: 'The messages in a thread (bodies as previews).' })
  @ApiResponse({ status: 200, description: 'The messages + count.' })
  async thread(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('threadId') threadId: string,
  ) {
    const messages = await this.email.listThreadMessages(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      threadId,
      mailboxId,
    );
    return { messages, count: messages.length };
  }

  @Post(':mailboxId/compose')
  @ApiOperation({ summary: 'Send an email AS the given mailbox (reply when in_reply_to_thread_id).' })
  @ApiResponse({ status: 201, description: 'The composed message (queued/sent/failed-clean).' })
  async compose(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Body() body: ComposeMailDto,
  ) {
    const input: ComposeInput = {
      contactId: null,
      toAddress: body.to_address,
      subject: body.subject ?? '',
      body: body.body ?? '',
      mode: 'send',
      inReplyToThreadId: body.in_reply_to_thread_id ?? null,
      externalSource: 'email-ops-client',
      externalRef: randomUUID(),
      draftedBy: null,
      fromMailboxAccountId: mailboxId,
    };
    return this.email.composeEmail(workspaceId, ucUidOf(user as WithWorkspaceClaim), input);
  }
}
