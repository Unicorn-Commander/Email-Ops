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
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AgentInboxKind, AgentInboxState, User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
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

@ApiTags('agent-inbox')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/agent-inbox')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class AgentInboxController {
  constructor(private readonly email: EmailService) {}

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
    return { items, count: items.length };
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
  ) {
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
        : checkComposeEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
    const res = await this.email.approveAgentInboxItem(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
      body.note ?? null,
      body.trustRecipients,
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
