/**
 * Mail-triage REST surface — folder dispositions + the sender block/allow list.
 *
 *   PUT    workspaces/:workspaceId/mail/threads/:threadId/disposition  (SetDispositionDto)
 *   GET    workspaces/:workspaceId/mail/sender-policies
 *   POST   workspaces/:workspaceId/mail/sender-policies                (SetSenderPolicyDto)
 *   DELETE workspaces/:workspaceId/mail/sender-policies/:id
 *
 * JWT + membership guarded. Triage is a member-level action (managing your own
 * workspace's mail), so no provisioning-policy gate — the membership guard's
 * workspace scoping is the fence. Marking a thread Spam can, in one call, also
 * BLOCK the sender; marking it Not-Spam (→ INBOX) can ALLOW (trust) the sender.
 */

import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { MessageDisposition, SenderPolicyKind, SenderPolicyScope, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { SenderPolicyService } from './sender-policy.service';
import { SenderPolicyView } from './mail-triage.types';
import { EmailService } from '../email/email.service';

class SetDispositionDto {
  @IsEnum(MessageDisposition) disposition!: MessageDisposition;
  /** When moving to SPAM: also add a BLOCK rule for sender_address. */
  @IsOptional() @IsBoolean() block_sender?: boolean;
  /** When moving to INBOX (not-spam): also add an ALLOW (trust) rule for sender_address. */
  @IsOptional() @IsBoolean() trust_sender?: boolean;
  @IsOptional() @IsString() @MaxLength(320) sender_address?: string;
}

class SetSenderPolicyDto {
  @IsEnum(SenderPolicyScope) scope!: SenderPolicyScope;
  @IsString() @MaxLength(320) pattern!: string;
  @IsEnum(SenderPolicyKind) kind!: SenderPolicyKind;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

@ApiTags('mail-triage')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mail')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class MailTriageController {
  constructor(
    private readonly senderPolicy: SenderPolicyService,
    private readonly email: EmailService,
  ) {}

  @Put('threads/:threadId/disposition')
  @ApiOperation({ summary: 'Move a thread to a folder (Inbox/Archive/Trash/Spam); optionally block/trust the sender.' })
  @ApiResponse({ status: 200, description: 'The disposition (+ the sender rule, when applied).' })
  async setDisposition(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('threadId') threadId: string,
    @Body() body: SetDispositionDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    // Reconcile the REAL mailbox on James (move) AND tag the overlay, so the
    // manual triage sticks instead of reappearing on the next live refetch.
    const view = await this.email.applyThreadDisposition(workspaceId, ucUid, threadId, body.disposition);

    let senderRule: SenderPolicyView | null = null;
    if (body.sender_address && (body.block_sender || body.trust_sender)) {
      senderRule = await this.senderPolicy.set(workspaceId, ucUid, {
        scope: SenderPolicyScope.ADDRESS,
        pattern: body.sender_address,
        kind: body.block_sender ? SenderPolicyKind.BLOCK : SenderPolicyKind.ALLOW,
        reason: body.block_sender ? 'Blocked from Spam triage' : 'Trusted from Not-Spam triage',
      });
    }
    return { disposition: view, sender_policy: senderRule };
  }

  @Get('sender-policies')
  @ApiOperation({ summary: 'List the workspace sender block/allow rules.' })
  async listSenderPolicies(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.senderPolicy.list(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items, count: items.length };
  }

  @Post('sender-policies')
  @ApiOperation({ summary: 'Add or update a sender block/allow rule (upsert on scope+pattern).' })
  @ApiResponse({ status: 201, description: 'The rule.' })
  async setSenderPolicy(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: SetSenderPolicyDto,
  ) {
    return this.senderPolicy.set(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      scope: body.scope,
      pattern: body.pattern,
      kind: body.kind,
      reason: body.reason ?? null,
    });
  }

  @Delete('sender-policies/:id')
  @ApiOperation({ summary: 'Remove a sender rule.' })
  @ApiResponse({ status: 404, description: 'No such rule in this workspace.' })
  async removeSenderPolicy(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const removed = await this.senderPolicy.remove(workspaceId, ucUidOf(user as WithWorkspaceClaim), id);
    if (!removed) throw new NotFoundException('Sender rule not found in this workspace.');
    return { removed: true };
  }
}
