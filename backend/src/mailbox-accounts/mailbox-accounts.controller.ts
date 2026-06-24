/**
 * Mailbox-management REST surface.
 *
 *   GET   workspaces/:workspaceId/mailboxes
 *   GET   workspaces/:workspaceId/mailboxes/:id
 *   POST  workspaces/:workspaceId/mailboxes            (CreateMailboxDto)
 *   PATCH workspaces/:workspaceId/mailboxes/:id         (UpdateMailboxDto)
 *
 * JWT + membership guarded. Writes gate through the provisioning policy: a HUMAN
 * mailbox uses humanMailbox.*, an AGENT mailbox (a send identity) uses
 * agentMailbox.* (ADMIN_ONLY by default). A self-owned human mailbox can use the
 * self-service escape. Reads are member-level.
 */

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { MailboxOwnerKind, User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { ProvisionDecision } from '../provisioning/provisioning-policy';
import { MailboxAccountsService } from './mailbox-accounts.service';
import { CreateMailboxInput, UpdateMailboxInput } from './mailbox-accounts.types';

class CreateMailboxDto {
  @IsString() @MaxLength(320) email_address!: string;
  @IsOptional() @IsString() @MaxLength(200) display_name?: string;
  @IsOptional() @IsEnum(MailboxOwnerKind) owner_kind?: MailboxOwnerKind;
  @IsOptional() @IsString() @MaxLength(255) owner_key?: string;
  @IsOptional() @IsBoolean() postmark_lane?: boolean;
}

class UpdateMailboxDto {
  @IsOptional() @IsString() @MaxLength(200) display_name?: string | null;
  @IsOptional() @IsEnum(MailboxOwnerKind) owner_kind?: MailboxOwnerKind;
  @IsOptional() @IsString() @MaxLength(255) owner_key?: string | null;
  @IsOptional() @IsBoolean() postmark_lane?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

@ApiTags('mailboxes')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mailboxes')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class MailboxAccountsController {
  constructor(
    private readonly mailboxes: MailboxAccountsService,
    private readonly policy: ProvisioningPolicyService,
  ) {}

  private blockIfApprovalGated(decision: ProvisionDecision, action: string): void {
    if (decision === 'requires_approval') {
      throw new ForbiddenException(
        `"${action}" requires approval under this workspace's policy; the approval workflow is being enabled.`,
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'List the workspace mailboxes (human / agent / shared).' })
  async list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.mailboxes.listMailboxes(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items, count: items.length };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one mailbox.' })
  @ApiResponse({ status: 404, description: 'No such mailbox in this workspace.' })
  async get(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User, @Param('id') id: string) {
    const mb = await this.mailboxes.getMailbox(workspaceId, ucUidOf(user as WithWorkspaceClaim), id);
    if (!mb) throw new NotFoundException('Mailbox not found in this workspace.');
    return mb;
  }

  @Post()
  @ApiOperation({ summary: 'Create a mailbox (human / agent / shared). Policy-gated by kind.' })
  @ApiResponse({ status: 201, description: 'The created mailbox.' })
  @ApiResponse({ status: 409, description: 'That address already exists here.' })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Body() body: CreateMailboxDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    this.mailboxes.assertValidAddress(body.email_address);
    const ownerKind = body.owner_kind ?? MailboxOwnerKind.SHARED;
    const action = ownerKind === MailboxOwnerKind.AGENT ? 'agentMailbox.create' : 'humanMailbox.create';
    const isSelfOwnMailbox = ownerKind === MailboxOwnerKind.HUMAN && !!ucUid && body.owner_key === ucUid;
    const input: CreateMailboxInput = {
      emailAddress: body.email_address,
      displayName: body.display_name ?? null,
      ownerKind,
      ownerKey: body.owner_key ?? null,
      postmarkLane: body.postmark_lane,
    };
    const decision = await this.policy.authorize(workspaceId, ucUid, role, action, { isSelfOwnMailbox });
    if (decision === 'requires_approval') {
      // APPROVAL mode: file a request instead of applying; an approver replays it.
      const filed = await this.policy.fileRequest(workspaceId, ucUid, {
        kind: ownerKind === MailboxOwnerKind.AGENT ? 'AGENT_MAILBOX' : 'HUMAN_MAILBOX',
        action: 'create',
        payload: input,
        summary: `Create ${ownerKind.toLowerCase()} mailbox ${body.email_address}`,
      });
      return { provisioning_request: filed };
    }
    return this.mailboxes.createMailbox(workspaceId, ucUid, input);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a mailbox. Policy-gated by the mailbox kind.' })
  @ApiResponse({ status: 404, description: 'No such mailbox in this workspace.' })
  async update(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
    @Body() body: UpdateMailboxDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const existing = await this.mailboxes.getMailbox(workspaceId, ucUid, id);
    if (!existing) throw new NotFoundException('Mailbox not found in this workspace.');
    const action =
      existing.owner_kind === MailboxOwnerKind.AGENT ? 'agentMailbox.edit' : 'humanMailbox.edit';
    this.blockIfApprovalGated(await this.policy.authorize(workspaceId, ucUid, role, action), action);

    const patch: UpdateMailboxInput = {};
    if (body.display_name !== undefined) patch.displayName = body.display_name;
    if (body.owner_kind !== undefined) patch.ownerKind = body.owner_kind;
    if (body.owner_key !== undefined) patch.ownerKey = body.owner_key;
    if (body.postmark_lane !== undefined) patch.postmarkLane = body.postmark_lane;
    if (body.active !== undefined) patch.active = body.active;
    const updated = await this.mailboxes.updateMailbox(workspaceId, ucUid, id, patch);
    if (!updated) throw new NotFoundException('Mailbox not found in this workspace.');
    return updated;
  }
}
