import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipService } from '../common/workspace/membership.service';
import { entitlementsOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ConnectedAccountsService } from './connected-accounts.service';
import { ConnectedProvider } from './connected-accounts.types';
import { checkCleanerEntitlement } from './entitlement';

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
