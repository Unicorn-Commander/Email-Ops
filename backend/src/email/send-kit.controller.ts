import { Body, Controller, ForbiddenException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { User } from '@prisma/client';
import { ExplicitCredentialGuard } from '../auth/guards/explicit-credential.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipService } from '../common/workspace/membership.service';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import {
  AgentSendKitExtensionInput,
  AgentSendKitReproposalInput,
  AgentSendKitReturnInput,
  EmailService,
} from './email.service';

class ExtendSendKitDto {
  @IsISO8601()
  expires_at!: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/i)
  template_sha256!: string;
}

class ReproposeSendKitDto {
  @IsISO8601()
  expires_at!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  new_kit_id?: string;
}

class ReturnSendKitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}

function assertSignedInHuman(user: User): void {
  const identity = user as User & {
    __patAuth?: unknown;
    __isFederationActor?: boolean;
    __isFederationAuth?: boolean;
  };
  if (identity.__patAuth || identity.__isFederationActor || identity.__isFederationAuth) {
    throw new ForbiddenException('Only a signed-in human may manage send-kit lifecycle actions.');
  }
}

@ApiTags('agent-inbox')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/agent-inbox')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class SendKitController {
  constructor(
    private readonly email: EmailService,
    private readonly membership: MembershipService,
  ) {}

  @Post('send-kits/:kitId/extend')
  @UseGuards(ExplicitCredentialGuard)
  @ApiOperation({ summary: 'Human-only extension of a send-kit expiry.' })
  async extend(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('kitId') kitId: string,
    @Body() body: ExtendSendKitDto,
  ) {
    assertSignedInHuman(user);
    await this.membership.assertCanReviewInbox(user, workspaceId);
    const input: AgentSendKitExtensionInput = {
      kitId,
      expiresAt: new Date(body.expires_at),
      templateSha256: body.template_sha256,
    };
    return this.email.extendSendKit(workspaceId, ucUidOf(user as WithWorkspaceClaim), input);
  }

  @Post('send-kits/:kitId/re-propose')
  @UseGuards(ExplicitCredentialGuard)
  @ApiOperation({ summary: 'Human-only re-proposal of the unsent send-kit recipients.' })
  async repropose(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('kitId') kitId: string,
    @Body() body: ReproposeSendKitDto,
  ) {
    assertSignedInHuman(user);
    await this.membership.assertCanReviewInbox(user, workspaceId);
    const input: AgentSendKitReproposalInput = {
      kitId,
      expiresAt: new Date(body.expires_at),
      newKitId: body.new_kit_id,
    };
    return this.email.reproposeSendKit(workspaceId, ucUidOf(user as WithWorkspaceClaim), input);
  }

  @Post('send-kits/:kitId/return')
  @UseGuards(ExplicitCredentialGuard)
  @ApiOperation({ summary: 'Human-only return of a send kit to its drafting agent.' })
  async returnToAgent(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('kitId') kitId: string,
    @Body() body: ReturnSendKitDto,
  ) {
    assertSignedInHuman(user);
    await this.membership.assertCanReviewInbox(user, workspaceId);
    const input: AgentSendKitReturnInput = { kitId, note: body.note };
    return this.email.returnSendKitToAgent(workspaceId, ucUidOf(user as WithWorkspaceClaim), input);
  }
}
