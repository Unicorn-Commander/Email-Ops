/**
 * The trusted-correspondents REST surface (Wave 7).
 *
 * Path: workspaces/:workspaceId/trusted-correspondents — workspace-scoped, under
 * the same JwtAuthGuard + WorkspaceMembershipGuard pair as the other authed
 * surfaces (viewer-level read, member-level write — membership is the gate,
 * mirroring the mail-rules surface). Delegates to the SAME service the MCP
 * tools use, so there is one implementation and one RLS path.
 *
 *   GET    workspaces/:workspaceId/trusted-correspondents          → { items }
 *   POST   workspaces/:workspaceId/trusted-correspondents          { address, note? }
 *   DELETE workspaces/:workspaceId/trusted-correspondents/:rowId   → { ok: true }
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { TrustedCorrespondentsService } from './trusted-correspondents.service';

class AddTrustedCorrespondentDto {
  // An address (jane@acme.com) or a bare domain (acme.com). scope is inferred
  // from the value when omitted; pass it explicitly to disambiguate.
  @IsString() @MaxLength(320) address!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsIn(['address', 'domain']) scope?: 'address' | 'domain';
}

@ApiTags('trusted-correspondents')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/trusted-correspondents')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class TrustedCorrespondentsController {
  constructor(private readonly trusted: TrustedCorrespondentsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List the workspace trusted correspondents — the outbound addresses an L2 ' +
      'agent may auto-send to (learned from approvals or added manually).',
  })
  @ApiResponse({ status: 200, description: '{ items: TrustedCorrespondentView[] }' })
  async list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.trusted.list(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items };
  }

  @Post()
  @ApiOperation({ summary: 'Manually trust a correspondent address (source MANUAL; idempotent).' })
  @ApiResponse({ status: 201, description: 'The created/updated TrustedCorrespondentView.' })
  async add(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: AddTrustedCorrespondentDto,
  ) {
    return this.trusted.add(workspaceId, ucUidOf(user as WithWorkspaceClaim), {
      address: body.address,
      note: body.note ?? null,
      scope: body.scope ?? null,
    });
  }

  @Delete(':rowId')
  @ApiOperation({ summary: 'Untrust a correspondent (delete by row id).' })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  @ApiResponse({ status: 404, description: 'No such trusted correspondent in this workspace.' })
  async remove(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('rowId') rowId: string,
  ) {
    const removed = await this.trusted.remove(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      rowId,
    );
    if (!removed) {
      throw new NotFoundException('Trusted correspondent not found in this workspace.');
    }
    return { ok: true };
  }
}
