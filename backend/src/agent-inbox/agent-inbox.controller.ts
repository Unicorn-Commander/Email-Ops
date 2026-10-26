/**
 * The agent-inbox REST surface (Phase 2, Part B).
 *
 * Path: workspaces/:workspaceId/agent-inbox — workspace-scoped (SUITE-IDENTITY
 * §D4: the path is the workspace addressing). Under the user-JWT (JwtAuthGuard)
 * + workspace-membership (WorkspaceMembershipGuard) guards, mirroring the auth
 * pattern of the other authed surfaces.
 *
 *   GET    workspaces/:workspaceId/agent-inbox?state=pending|approved|rejected
 *   POST   workspaces/:workspaceId/agent-inbox/:id/approve   (body: { note? })
 *   POST   workspaces/:workspaceId/agent-inbox/:id/reject    (body: { note? })
 *
 * Every action DELEGATES to the EXISTING EmailService methods (listAgentInbox /
 * approveAgentInboxItem / rejectAgentInboxItem) — the SAME implementation the MCP
 * tools call, so the approval logic + the RLS write path are not duplicated. The
 * controller's only added responsibility over the MCP tool is being the HTTP
 * front door: it resolves the acting user + the guard-authorized workspace, and
 * (for approve) re-derives the entitlement gate server-side BY ITEM KIND exactly
 * like the MCP approve tool: an EMAIL approval SENDS outbound mail (dual-SKU
 * compose gate), a CLEANUP approval merely runs a cleaner batch (cleaner SKU).
 */

import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { AgentInboxKind, AgentInboxState, User, WorkspaceRole } from '@prisma/client';
import { ExplicitCredentialGuard } from '../auth/guards/explicit-credential.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MembershipService } from '../common/workspace/membership.service';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { entitlementsOf, ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { EmailService } from '../email/email.service';
import { checkComposeEntitlement } from '../email/entitlement';
import { checkCleanerEntitlement } from '../connected-accounts/entitlement';

/** Optional reviewer note carried on an approve/reject. */
class ReviewBodyDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
  /**
   * Wave 7 approve-path learning: default TRUE — approving an EMAIL draft
   * trusts its external recipients (upserts trusted_correspondents). Pass
   * false to approve this one send without learning.
   */
  @IsOptional()
  @IsBoolean()
  trustRecipients?: boolean;
}

/** The state filter for the queue list (defaults to pending in the service). */
class InboxQueryDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  state?: 'pending' | 'approved' | 'rejected';
}

class ApproveSendKitDto {
  @IsString() @MaxLength(200) kit_id!: string;
  @IsString() @Matches(/^[0-9a-f]{64}$/i) template_sha256!: string;
  @IsOptional() @IsString() @MaxLength(100000) body_template?: string;
  @IsOptional() @IsObject() placeholder_rules?: Record<string, string>;
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @ArrayMaxSize(100)
  optional_lines?: number[];
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  subjects?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  recipients?: string[];
  @IsOptional() @IsString() @MaxLength(320) from_address?: string;
  @IsOptional() @IsInt() @Min(0) cap_per_day?: number;
  @IsOptional() @IsISO8601() expires_at?: string;
}

class ProposeSendKitDto {
  @IsString() @MaxLength(200) kit_id!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(100000) body_template!: string;
  @IsOptional() @IsObject() placeholder_rules?: Record<string, string>;
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @ArrayMaxSize(100)
  optional_lines?: number[];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  subjects!: string[];
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(320, { each: true })
  recipients!: string[];
  @IsString() @MaxLength(320) from_address!: string;
  @IsInt() @Min(0) cap_per_day!: number;
  @IsISO8601() expires_at!: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

class SendKitQueryDto {
  @IsOptional()
  @IsIn(['PROPOSED', 'APPROVED', 'REJECTED'])
  state?: 'PROPOSED' | 'APPROVED' | 'REJECTED';
}

class ApproveSendKitHashDto {
  @IsString() @Matches(/^[0-9a-f]{64}$/i) template_sha256!: string;
}

class RejectSendKitDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

@ApiTags('agent-inbox')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/agent-inbox')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AgentInboxController {
  constructor(
    private readonly email: EmailService,
    private readonly membership: MembershipService,
  ) {}

  @Post('send-kits/approve')
  @UseGuards(ExplicitCredentialGuard)
  @ApiOperation({ summary: 'Human-only approval of an agent send kit template.' })
  async approveSendKit(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: ApproveSendKitDto,
  ) {
    if ((user as any).__patAuth || (user as any).__isFederationActor || (user as any).__isFederationAuth) {
      throw new ForbiddenException('Only a signed-in human may approve a send kit.');
    }
    await this.membership.assertCanReviewInbox(user, workspaceId);
    return this.email.approveSendKit(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      kitId: body.kit_id,
      bodyTemplate: body.body_template,
      placeholderRules: body.placeholder_rules,
      optionalLines: body.optional_lines,
      subjects: body.subjects,
      recipients: body.recipients,
      fromAddress: body.from_address,
      capPerDay: body.cap_per_day,
      templateSha256: body.template_sha256,
      expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
    });
  }

  @Post('send-kits')
  @ApiOperation({ summary: 'Propose a personalised agent send kit for human review.' })
  async proposeSendKit(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: ProposeSendKitDto,
  ) {
    const gate = checkComposeEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) throw new ForbiddenException(gate.reason);
    return this.email.proposeSendKit(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      kitId: body.kit_id,
      title: body.title,
      bodyTemplate: body.body_template,
      placeholderRules: body.placeholder_rules,
      optionalLines: body.optional_lines,
      subjects: body.subjects,
      recipients: body.recipients,
      fromAddress: body.from_address,
      capPerDay: body.cap_per_day,
      expiresAt: new Date(body.expires_at),
      note: body.note,
    });
  }

  @Get('send-kits')
  @ApiOperation({ summary: 'List personalised send-kit proposals and approvals.' })
  async listSendKits(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query() query: SendKitQueryDto,
  ) {
    const items = await this.email.listSendKits(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      query.state ? (query.state as import('@prisma/client').AgentSendKitState) : undefined,
    );
    const humanSession = !(user as any).__patAuth && !(user as any).__isFederationActor;
    return { items, count: items.length, human_session: humanSession };
  }

  @Get('send-kits/:kitId')
  @ApiOperation({ summary: 'Get the full definition of one send kit.' })
  async getSendKit(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('kitId') kitId: string,
  ) {
    const kit = await this.email.getSendKit(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      kitId,
    );
    if (!kit) throw new NotFoundException('Send kit not found in this workspace.');
    return kit;
  }

  @Post('send-kits/:kitId/approve')
  @UseGuards(ExplicitCredentialGuard)
  @ApiOperation({ summary: 'Human-only approval of a proposed send kit by its displayed hash.' })
  async approveSendKitProposal(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('kitId') kitId: string,
    @Body() body: ApproveSendKitHashDto,
  ) {
    if ((user as any).__patAuth || (user as any).__isFederationActor || (user as any).__isFederationAuth) {
      throw new ForbiddenException('Only a signed-in human may approve a send kit.');
    }
    await this.membership.assertCanReviewInbox(user, workspaceId);
    return this.email.approveSendKit(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      kitId,
      templateSha256: body.template_sha256,
    });
  }

  @Post('send-kits/:kitId/reject')
  @UseGuards(ExplicitCredentialGuard)
  @ApiOperation({ summary: 'Human-only rejection of a proposed send kit.' })
  async rejectSendKit(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('kitId') kitId: string,
    @Body() body: RejectSendKitDto,
  ) {
    if ((user as any).__patAuth || (user as any).__isFederationActor || (user as any).__isFederationAuth) {
      throw new ForbiddenException('Only a signed-in human may reject a send kit.');
    }
    await this.membership.assertCanReviewInbox(user, workspaceId);
    return this.email.rejectSendKit(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      kitId,
      body.note,
    );
  }

  @Get()
  @ApiOperation({
    summary:
      'List the agent-inbox queue for a workspace (agent-drafted mail awaiting ' +
      'human approval). Defaults to pending; pass ?state to filter.',
  })
  @ApiResponse({ status: 200, description: 'The queue items + count.' })
  async list(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query() query: InboxQueryDto,
  ) {
    const items = await this.email.listAgentInbox(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      this.inboxState(query.state),
    );
    const pendingCount =
      !query.state || query.state === 'pending'
        ? await (typeof (this.email as any).countAgentInboxPending === 'function'
            ? this.email.countAgentInboxPending(workspaceId, ucUidOf(user as WithWorkspaceClaim))
            : Promise.resolve(items.length))
        : items.length;
    return { items, count: pendingCount };
  }

  // NOTE: declared BEFORE @Get(':id') so 'auto-sent' never matches as an item id.
  @Get('auto-sent')
  @ApiOperation({
    summary:
      'The auto-sent audit feed (Wave 7): AUTONOMOUS_SEND events newest-first, ' +
      'each joined to the FULL message that left without a human in the loop.',
  })
  @ApiResponse({ status: 200, description: '{ items: AutoSentItemView[] }' })
  async autoSent(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
  ) {
    const items = await this.email.listAutoSentFeed(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      limit ? Number(limit) : undefined,
    );
    return { items };
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'One agent-inbox item with the FULL staged message (both bodies, every ' +
      'recipient, attachment meta) + payload.policy (why the gate held it).',
  })
  @ApiResponse({ status: 200, description: '{ item: AgentInboxDetailView }' })
  @ApiResponse({ status: 404, description: 'No such item in this workspace.' })
  async detail(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const item = await this.email.getAgentInboxItemDetail(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
    );
    if (!item) {
      throw new NotFoundException('Agent-inbox item not found in this workspace.');
    }
    return { item };
  }

  @Post(':id/approve')
  @ApiOperation({
    summary:
      'Approve a pending agent-inbox draft: hand it to the send lane and advance ' +
      'the message to queued/sent. This is the human-in-the-loop SEND.',
  })
  @ApiResponse({ status: 200, description: 'The updated inbox item + message.' })
  @ApiResponse({
    status: 403,
    description:
      'Caller lacks the SKU for this item kind: EMAIL (a send) requires the dual ' +
      'customer-ops+email-ops SKU; CLEANUP requires only the email-ops cleaner SKU.',
  })
  @ApiResponse({ status: 404, description: 'No such pending item in this workspace.' })
  async approve(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: ReviewBodyDto,
    @WorkspaceRoleParam() role?: WorkspaceRole,
  ) {
    await this.membership.assertCanReviewInbox(user, workspaceId);
    // Gate BY KIND (defense-in-depth, re-derived off the verified token; mirrors
    // the MCP approve tool). Peek first: a missing/foreign id 404s before any
    // entitlement verdict. A CLEANUP approval merely runs a cleaner batch →
    // cleaner SKU; anything else (EMAIL) SENDS → the dual-SKU compose gate.
    const kind = await this.email.peekAgentInboxKind(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
    );
    if (kind === null) {
      throw new NotFoundException('Agent-inbox item not found in this workspace.');
    }
    const gate =
      kind === AgentInboxKind.CLEANUP
        ? checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId)
        : kind === AgentInboxKind.NOTICE
          ? { allowed: true as const, reason: '' }
          : checkComposeEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    const res =
      role === undefined
        ? await this.email.approveAgentInboxItem(
            workspaceId,
            ucUidOf(user as WithWorkspaceClaim),
            id,
            body.note ?? null,
            body.trustRecipients,
          )
        : await this.email.approveAgentInboxItem(
            workspaceId,
            ucUidOf(user as WithWorkspaceClaim),
            id,
            body.note ?? null,
            body.trustRecipients,
            false,
            role,
          );
    if (!res) {
      throw new NotFoundException('Agent-inbox item not found in this workspace.');
    }
    return res;
  }

  @Post(':id/reject')
  @ApiOperation({
    summary:
      'Reject a pending agent-inbox draft: mark it rejected; the message is never ' +
      'sent. An optional note records why.',
  })
  @ApiResponse({ status: 200, description: 'The updated inbox item + message.' })
  @ApiResponse({ status: 404, description: 'No such pending item in this workspace.' })
  async reject(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: ReviewBodyDto,
  ) {
    await this.membership.assertCanReviewInbox(user, workspaceId);
    const res = await this.email.rejectAgentInboxItem(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
      body.note ?? null,
    );
    if (!res) {
      throw new NotFoundException('Agent-inbox item not found in this workspace.');
    }
    return res;
  }

  private inboxState(s?: string): AgentInboxState | undefined {
    switch ((s ?? '').toLowerCase()) {
      case 'approved':
        return AgentInboxState.APPROVED;
      case 'rejected':
        return AgentInboxState.REJECTED;
      case 'pending':
        return AgentInboxState.PENDING;
      default:
        return undefined; // service defaults to PENDING
    }
  }
}
