import { Controller, Get, UseGuards, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces } from '../common/workspace/list-my-workspaces';
import { KeycloakBrokerService } from './keycloak-broker.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly membership: MembershipService,
    private readonly broker: KeycloakBrokerService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('keycloak')
  @UseGuards(AuthGuard('keycloak'))
  @ApiOperation({ summary: 'Redirect to Keycloak SSO login (uchub realm)' })
  @ApiResponse({ status: 302, description: 'Redirects to Keycloak login page' })
  async keycloakLogin() {
    // Passport handles the redirect to Keycloak.
  }

  @Get('keycloak/callback')
  @UseGuards(AuthGuard('keycloak'))
  @ApiOperation({ summary: 'Keycloak OAuth callback (uchub realm)' })
  @ApiResponse({ status: 302, description: 'Redirects to frontend with JWT token' })
  async keycloakCallback(@Req() req: any, @Res() res: any) {
    const tokenData = await this.authService.generateTokenForUser(req.user);
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'https://emailops.unicorncommander.ai',
    );
    return res.redirect(`${frontendUrl}/auth/sso-callback?token=${tokenData.access_token}`);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Returns user profile' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User) {
    // Resolve the avatar photo. It's captured at login, but already-signed-in
    // users have none stored yet — live-fetch the Keycloak `picture` claim once
    // and cache it so the photo appears without forcing a re-login.
    let picture = user.picture ?? null;
    if (!picture) {
      picture = await this.broker.getUserPicture(user).catch(() => null);
      if (picture) {
        await this.prisma.user
          .update({ where: { id: user.id }, data: { picture } })
          .catch(() => undefined);
      }
    }
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      picture,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  @Get('me/workspaces')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the workspaces the caller is an active member of' })
  @ApiResponse({ status: 200, description: 'Returns the caller’s active workspaces' })
  async myWorkspaces(@CurrentUser() user: User) {
    return { workspaces: await listMyWorkspaces(this.membership, user) };
  }
}
