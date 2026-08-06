import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { MailRulesService } from './mail-rules.service';

// match/actions are rule-engine JSON; the DTO only pins their container types —
// the service is the real validator (parseMatch/parseActions + policy checks).
class CreateMailRuleDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() priority?: number;
  @IsObject() match!: Record<string, unknown>;
  @IsArray() actions!: unknown[];
}

class UpdateMailRuleDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsObject() match?: Record<string, unknown>;
  @IsOptional() @IsArray() actions?: unknown[];
}

@ApiTags('mail')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mailboxes/:mailboxId/rules')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class MailRulesController {
  constructor(private readonly rules: MailRulesService) {}

  @Get()
  @ApiOperation({ summary: 'List a mailbox\'s inbound mail rules (priority asc).' })
  @ApiResponse({ status: 200, description: '{ rules: MailRuleView[] }' })
  async list(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
  ) {
    const rules = await this.rules.list(workspaceId, ucUidOf(user as WithWorkspaceClaim), mailboxId);
    return { rules };
  }

  @Post()
  @ApiOperation({ summary: 'Create an inbound mail rule on one mailbox.' })
  @ApiResponse({ status: 201, description: 'The created MailRuleView.' })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Body() body: CreateMailRuleDto,
  ) {
    return this.rules.create(workspaceId, ucUidOf(user as WithWorkspaceClaim), mailboxId, {
      name: body.name,
      enabled: body.enabled,
      priority: body.priority,
      match: body.match,
      actions: body.actions,
    });
  }

  @Patch(':ruleId')
  @ApiOperation({ summary: 'Update any subset of an inbound mail rule\'s fields.' })
  @ApiResponse({ status: 200, description: 'The updated MailRuleView.' })
  async update(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: UpdateMailRuleDto,
  ) {
    const view = await this.rules.update(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      ruleId,
      {
        name: body.name,
        enabled: body.enabled,
        priority: body.priority,
        match: body.match,
        actions: body.actions,
      },
    );
    if (!view) throw new NotFoundException('Rule not found in this mailbox.');
    return view;
  }

  @Delete(':ruleId')
  @ApiOperation({ summary: 'Delete an inbound mail rule.' })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  async remove(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
    @Param('ruleId') ruleId: string,
  ) {
    const removed = await this.rules.remove(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      mailboxId,
      ruleId,
    );
    if (!removed) throw new NotFoundException('Rule not found in this mailbox.');
    return { ok: true };
  }
}
