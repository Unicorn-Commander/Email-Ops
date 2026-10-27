import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { User } from '@prisma/client';
import { Request, Response } from 'express';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { MembershipService } from '../common/workspace/membership.service';
import { ucUidOf } from '../common/workspace/workspace.util';
import { PrismaService } from '../prisma/prisma.service';
import { ApprovalKind, ApprovalLinksService } from './approval-links.service';
import {
  APPROVAL_COOKIE,
  APPROVAL_COOKIE_OPTIONS,
  ApprovalSessionService,
  cookieValue,
} from './approval-session.service';
import { ApprovalSessionGuard } from './approval-session.guard';
import { StandingApprovalsService } from './standing-approvals.service';
import { DAY_MS, standingBinding } from './standing-approval';
import { assertHumanApproval } from './human-approval';

export class ApprovalLinkDto {
  @IsString() @MaxLength(8000) token!: string;
  @IsOptional() @IsBoolean() remember?: boolean;
}

@Controller('approvals/:workspaceId')
@UseGuards(ApprovalSessionGuard, WorkspaceMembershipGuard)
export class ApprovalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: ApprovalLinksService,
    private readonly standing: StandingApprovalsService,
    private readonly sessions: ApprovalSessionService,
    private readonly membership: MembershipService,
  ) {}

  private async authorize(user: User, workspaceId: string) {
    assertHumanApproval(user);
    if (user.__approvalSession && user.__approvalSession.workspaceId !== workspaceId)
      throw new ForbiddenException('Different approval workspace.');
    await this.membership.assertCanReviewInbox(user, workspaceId);
  }

  @Post(':kind/:id/preview')
  @Header('Cache-Control', 'no-store')
  async preview(
    @ResolvedWorkspace() ws: string,
    @CurrentUser() user: User,
    @Param('kind') kind: ApprovalKind,
    @Param('id') id: string,
    @Body() body: ApprovalLinkDto,
  ) {
    await this.authorize(user, ws);
    return this.prisma.withWorkspace(ws, ucUidOf(user), async (tx) => {
      const target = await this.links.review(tx, ws, ucUidOf(user), kind, id, body.token, false);
      return {
        kind,
        ...target,
        canRemember: !(user as import('./human-approval').ApprovalUser).__approvalSession,
      };
    });
  }

  @Post(':kind/:id/approve')
  @Header('Cache-Control', 'no-store')
  async approve(
    @ResolvedWorkspace() ws: string,
    @CurrentUser() user: User,
    @Param('kind') kind: ApprovalKind,
    @Param('id') id: string,
    @Body() body: ApprovalLinkDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authorize(user, ws);
    assertHumanApproval(user);
    if (body.remember && user.__approvalSession)
      throw new ForbiddenException('Sign in again to extend an approval session.');
    const result = await this.prisma.withWorkspace(ws, ucUidOf(user), async (tx) => {
      const target = await this.links.review(tx, ws, ucUidOf(user), kind, id, body.token, true);
      if (target.standing) {
        await this.standing.approveInTx(
          tx,
          ws,
          user,
          target.standing,
          standingBinding(target.standing).definitionSha256,
        );
      } else {
        await tx.agentSendKit.update({
          where: { kitId: id, workspaceId: ws },
          data: {
            state: 'APPROVED',
            approvedBy: ucUidOf(user),
            approvedAt: new Date(),
            rejectedBy: null,
            rejectedAt: null,
          },
        });
      }
      return { cookie: body.remember ? await this.sessions.create(ws, user, tx) : null };
    });
    if (result.cookie)
      res.cookie(APPROVAL_COOKIE, result.cookie, {
        ...APPROVAL_COOKIE_OPTIONS,
        maxAge: 30 * DAY_MS,
      });
    return { id, approved: true };
  }

  @Post('session/forget')
  async forget(
    @ResolvedWorkspace() ws: string,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authorize(user, ws);
    assertHumanApproval(user);
    await this.sessions.revokeToken(cookieValue(req.headers.cookie, APPROVAL_COOKIE), user);
    res.clearCookie(APPROVAL_COOKIE, APPROVAL_COOKIE_OPTIONS);
    return { ok: true };
  }
}
