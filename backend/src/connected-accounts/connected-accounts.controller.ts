import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Query,
  ServiceUnavailableException,
  UseGuards,
  Param,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MembershipService } from '../common/workspace/membership.service';
import { entitlementsOf, ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ConnectedAccountsService } from './connected-accounts.service';
import { checkCleanerEntitlement } from './entitlement';
import {
  connectedAccountsPublicUrl,
  newOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from './oauth-state';

type OAuthProviderRoute = 'google' | 'microsoft';

@ApiTags('connected-accounts')
@ApiBearerAuth()
@Controller('connected-accounts')
@UseGuards(JwtAuthGuard)
export class ConnectedAccountsController {
  constructor(
    private readonly membership: MembershipService,
    private readonly connectedAccounts: ConnectedAccountsService,
  ) {}

  @Get('connect/:provider')
  @ApiOperation({
    summary: 'Start the OAuth connect flow for a Gmail or Microsoft 365 account.',
  })
  @ApiResponse({ status: 200, description: 'Returns the engine authorize URL + signed state.' })
  @ApiResponse({ status: 403, description: 'Caller lacks the email-ops SKU.' })
  @ApiResponse({ status: 503, description: 'Cleaner Engine is not configured.' })
  async connect(
    @Param('provider') provider: string,
    @Query('workspace_id') workspaceId: string | undefined,
    @CurrentUser() user: User,
  ) {
    const routeProvider = this.normalizeRouteProvider(provider);
    const engineProvider = this.engineProviderFor(routeProvider);
    const resolvedWorkspaceId = await this.membership.resolveAndAuthorize(user, workspaceId ?? null);

    const gate = checkCleanerEntitlement(
      entitlementsOf(user as WithWorkspaceClaim),
      resolvedWorkspaceId,
    );
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }

    const redirectUri = `${connectedAccountsPublicUrl()}/api/v1/connected-accounts/callback/${routeProvider}`;
    const state = signOAuthState({
      workspaceId: resolvedWorkspaceId,
      provider: engineProvider,
      ucUid: ucUidOf(user as WithWorkspaceClaim),
      nonce: newOAuthNonce(),
      iat: Date.now(),
    });

    const { authorizeUrl } = await this.connectedAccounts.getConnectUrl(
      resolvedWorkspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      engineProvider,
      redirectUri,
    );
    if (!authorizeUrl) {
      throw new ServiceUnavailableException('Cleaner Engine is not configured');
    }

    let authorizeUrlWithState: string;
    try {
      authorizeUrlWithState = this.appendState(authorizeUrl, state);
    } catch {
      throw new ServiceUnavailableException('Cleaner Engine returned an invalid authorize URL');
    }

    return {
      authorizeUrl: authorizeUrlWithState,
      state,
    };
  }

  @Get('callback/:provider')
  @ApiOperation({
    summary: 'Finalize the OAuth connect flow after the provider redirects back.',
  })
  @ApiResponse({ status: 200, description: 'Returns the connected account.' })
  @ApiResponse({ status: 400, description: 'Missing, invalid, expired, or denied OAuth state.' })
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @CurrentUser() user: User,
  ) {
    const routeProvider = this.normalizeRouteProvider(provider);
    const engineProvider = this.engineProviderFor(routeProvider);

    if (error) {
      throw new BadRequestException(errorDescription?.trim() || error.trim());
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code or state');
    }

    const verified = verifyOAuthState(state, engineProvider);
    if (!verified) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }

    const resolvedWorkspaceId = await this.membership.resolveAndAuthorize(
      user,
      verified.workspaceId,
    );
    if (resolvedWorkspaceId !== verified.workspaceId) {
      throw new BadRequestException('OAuth state workspace mismatch');
    }

    if (ucUidOf(user as WithWorkspaceClaim) !== verified.ucUid) {
      throw new BadRequestException('OAuth state user mismatch');
    }

    const redirectUri = `${connectedAccountsPublicUrl()}/api/v1/connected-accounts/callback/${routeProvider}`;
    return this.connectedAccounts.connectAccount(resolvedWorkspaceId, verified.ucUid, {
      provider: engineProvider,
      code,
      redirectUri,
    });
  }

  private appendState(authorizeUrl: string, state: string): string {
    const url = new URL(authorizeUrl);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private normalizeRouteProvider(provider: string): OAuthProviderRoute {
    const normalized = (provider ?? '').trim().toLowerCase();
    if (normalized === 'google' || normalized === 'gmail') {
      return 'google';
    }
    if (normalized === 'microsoft') {
      return 'microsoft';
    }
    throw new BadRequestException('provider must be google or microsoft');
  }

  private engineProviderFor(provider: OAuthProviderRoute): 'gmail' | 'microsoft' {
    return provider === 'google' ? 'gmail' : 'microsoft';
  }
}
