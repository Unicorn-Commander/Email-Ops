import {
  BadRequestException,
  Controller,
  Body,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipService } from '../common/workspace/membership.service';
import { entitlementsOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ConnectedAccountsService } from './connected-accounts.service';
import {
  CleanupExecutionResult,
  CleanupMode,
  CleanupPlanResult,
  CleanupWriteMode,
  ConnectedProvider,
} from './connected-accounts.types';
import { checkCleanerEntitlement } from './entitlement';

class CleanupPlanBodyDto {
  @IsOptional()
  @IsObject()
  criteria?: Record<string, unknown>;
}

class CleanupExecuteBodyDto {
  @IsIn(['trash', 'delete', 'archive_purge'])
  mode!: CleanupMode;

  @IsObject()
  plan!: CleanupPlanResult;
}

class CleanupOrganizeBodyDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsBoolean()
  archive?: boolean;

  @IsOptional()
  @IsObject()
  criteria?: Record<string, unknown>;
}

class CleanupUnsubscribeBodyDto {
  @IsArray()
  senderGroup!: string[];
}

class CleanupUndoBodyDto {
  @IsString()
  batchId!: string;
}

@ApiTags('connected-accounts')
@ApiBearerAuth()
@Controller('connected-accounts')
@UseGuards(JwtAuthGuard)
export class ConnectedAccountsController {
  constructor(
    private readonly membership: MembershipService,
    private readonly connectedAccounts: ConnectedAccountsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List provider accounts linked through the Keycloak identity broker.',
  })
  @ApiResponse({ status: 200, description: 'Linked-account status by provider.' })
  async list(@CurrentUser() user: User) {
    await this.resolveWorkspace(user);
    return this.connectedAccounts.listConnectedAccounts(user);
  }

  @Get(':provider/link-url')
  @ApiOperation({
    summary: 'Mint an in-app Keycloak account-link URL to connect this provider to the caller.',
  })
  @ApiResponse({ status: 200, description: 'A one-time Keycloak account-linking URL.' })
  async linkUrl(@CurrentUser() user: User, @Param('provider') providerParam: string) {
    const provider = this.provider(providerParam);
    await this.resolveWorkspace(user);
    return this.connectedAccounts.getProviderLinkUrl(user, provider);
  }

  @Get(':provider/stats')
  @ApiOperation({
    summary: 'Read aggregate inbox stats for a linked provider account.',
  })
  @ApiResponse({ status: 200, description: 'Stats, or a degrade-clean unavailable result.' })
  @ApiResponse({ status: 403, description: 'Caller lacks the email-ops cleaner SKU.' })
  async stats(@CurrentUser() user: User, @Param('provider') providerParam: string) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.getInboxStats(user, provider);
  }

  @Post(':provider/analyze')
  @ApiOperation({
    summary: 'Run a read-only inbox analysis for a linked provider account.',
  })
  @ApiResponse({ status: 200, description: 'Analysis, or a degrade-clean unavailable result.' })
  @ApiResponse({ status: 403, description: 'Caller lacks the email-ops cleaner SKU.' })
  async analyze(@CurrentUser() user: User, @Param('provider') providerParam: string) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.analyzeInbox(user, provider);
  }

  @Post(':provider/cleanup/plan')
  @ApiOperation({
    summary: 'Build a dry-run cleanup plan with protected and safe rows separated.',
  })
  @ApiResponse({ status: 200, description: 'The cleanup plan.' })
  @ApiResponse({ status: 403, description: 'Caller lacks the email-ops cleaner SKU.' })
  async plan(
    @CurrentUser() user: User,
    @Param('provider') providerParam: string,
    @Body() body: CleanupPlanBodyDto,
  ) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.planCleanup(user, provider, body.criteria ?? {});
  }

  @Post(':provider/cleanup/execute')
  @ApiOperation({
    summary: 'Execute a cleanup plan as trash or delete, with backup verification for delete.',
  })
  @ApiResponse({ status: 200, description: 'The cleanup execution result.' })
  @ApiResponse({ status: 403, description: 'Caller lacks the email-ops cleaner SKU.' })
  async execute(
    @CurrentUser() user: User,
    @Param('provider') providerParam: string,
    @Body() body: CleanupExecuteBodyDto,
  ): Promise<CleanupExecutionResult> {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.executeCleanup(user, provider, body.plan, body.mode);
  }

  @Post(':provider/organize')
  @ApiOperation({
    summary: 'Organize messages by label/archive semantics (degrade-clean audit batch).',
  })
  async organize(
    @CurrentUser() user: User,
    @Param('provider') providerParam: string,
    @Body() body: CleanupOrganizeBodyDto,
  ) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.organize(user, provider, body.criteria ?? {
      label: body.label ?? '',
      archive: body.archive ?? true,
    });
  }

  @Post(':provider/unsubscribe')
  @ApiOperation({
    summary: 'Unsubscribe from a sender group (audit batch; degrade-clean if no engine write).',
  })
  async unsubscribe(
    @CurrentUser() user: User,
    @Param('provider') providerParam: string,
    @Body() body: CleanupUnsubscribeBodyDto,
  ) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.unsubscribe(user, provider, body.senderGroup);
  }

  @Post(':provider/undo')
  @ApiOperation({
    summary: 'Undo a cleanup batch (audit state update; best-effort revert semantics).',
  })
  async undo(
    @CurrentUser() user: User,
    @Param('provider') providerParam: string,
    @Body() body: CleanupUndoBodyDto,
  ) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.undoBatch(user, provider, body.batchId);
  }

  @Post(':provider/cleanup/:batchId/restore')
  @ApiOperation({
    summary: 'Restore a cleanup batch from a live cloud archive.',
  })
  async restore(
    @CurrentUser() user: User,
    @Param('provider') providerParam: string,
    @Param('batchId') batchId: string,
  ) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.undoBatch(user, provider, batchId);
  }

  @Get(':provider/cleanup/:batchId/archive-download')
  @ApiOperation({
    summary: 'Create a short-lived presigned archive download URL.',
  })
  async archiveDownload(
    @CurrentUser() user: User,
    @Param('provider') providerParam: string,
    @Param('batchId') batchId: string,
  ) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return this.connectedAccounts.getArchiveDownloadUrl(user, provider, batchId);
  }

  @Get(':provider/cleanup/activity')
  @ApiOperation({
    summary: 'List recent cleanup activity batches for the provider.',
  })
  async activity(@CurrentUser() user: User, @Param('provider') providerParam: string) {
    const provider = this.provider(providerParam);
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    return { items: await this.connectedAccounts.listCleanupActivity(user, provider) };
  }

  private resolveWorkspace(user: User): Promise<string> {
    return this.membership.resolveAndAuthorize(user, null);
  }

  private requireCleanerEntitlement(user: User, workspaceId: string): void {
    const gate = checkCleanerEntitlement(entitlementsOf(user as WithWorkspaceClaim), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
  }

  private provider(value: string): ConnectedProvider {
    if (value === 'gmail' || value === 'microsoft') return value;
    throw new BadRequestException('provider must be one of: gmail, microsoft');
  }
}
