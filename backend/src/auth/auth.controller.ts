import { Body, Controller, Get, Post, UseGuards, Req, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiProperty } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { listMyWorkspaces } from '../common/workspace/list-my-workspaces';
import { KeycloakBrokerService } from './keycloak-broker.service';
import { PrismaService } from '../prisma/prisma.service';

export class LocalLoginDto {
  @ApiProperty({ example: 'admin@example.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 12, writeOnly: true })
  @IsString()
  @MinLength(12)
  password!: string;
}

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
  @ApiResponse({ status: 302, description: 'Sets the session cookie + redirects to the frontend' })
  async keycloakCallback(@Req() req: any, @Res() res: any) {
    const tokenData = await this.authService.generateTokenForUser(req.user);
    const frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'https://emailops.unicorncommander.ai',
    );
    // Carry the session in an HttpOnly cookie (same-origin) instead of the redirect
    // URL. HttpOnly+Secure = not JS-readable and not leaked into browser history /
    // logs / referrers the way `?token=` was. SameSite=Lax still sends it on the
    // top-level nav back from Keycloak and on same-origin API calls. The Bearer
    // header path stays intact for MCP / PAT (see JwtStrategy).
    this.setSessionCookie(res, tokenData.access_token);
    return res.redirect(`${frontendUrl}/auth/sso-callback`);
  }

  @Get('local/enabled')
  @ApiOperation({ summary: 'Report whether self-host local login is configured' })
  @ApiResponse({ status: 200, description: '{ enabled: boolean }' })
  localLoginEnabled() {
    return { enabled: this.authService.isLocalLoginEnabled() };
  }

  @Post('local/login')
  @ApiOperation({ summary: 'Sign in with the self-host bootstrap admin' })
  @ApiResponse({
    status: 200,
    description: 'Returns a local session JWT and sets the session cookie',
  })
  @ApiResponse({ status: 401, description: 'Invalid local admin credentials' })
  async localLogin(@Body() body: LocalLoginDto, @Res() res: any) {
    const tokenData = await this.authService.localLogin(body.email, body.password);
    this.setSessionCookie(res, tokenData.access_token);
    return res.json(tokenData);
  }

  @Post('logout')
  @ApiOperation({ summary: 'Clear the session cookie (sign out).' })
  @ApiResponse({ status: 200, description: '{ ok: true } — the access_token cookie is cleared.' })
  logout(@Res() res: any) {
    res.clearCookie('access_token', { path: '/' });
    res.clearCookie('eo_approval_session', { path: '/api/v1/approvals', httpOnly: true, secure: true, sameSite: 'strict' });
    return res.json({ ok: true });
  }

  /**
   * Cookie lifetime (ms) matched to the signed token's JWT_EXPIRES_IN so the
   * cookie and the JWT it carries expire together. Handles `<n>[smhd]` and a
   * bare-seconds number; defaults to 1 day (the JwtModule default).
   */
  private sessionCookieMaxAgeMs(): number {
    const raw = (this.configService.get<string>('JWT_EXPIRES_IN', '1d') || '1d').trim();
    const m = raw.match(/^(\d+)\s*([smhd])?$/i);
    if (!m) return 24 * 60 * 60 * 1000;
    const n = parseInt(m[1], 10);
    const unit = (m[2] || 's').toLowerCase();
    const mult = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    return n * mult * 1000;
  }

  private setSessionCookie(res: any, token: string): void {
    const configured = this.configService.get<string>('AUTH_COOKIE_SECURE');
    const secure =
      configured === undefined
        ? this.configService.get<string>('FRONTEND_URL', '').startsWith('https://')
        : configured === 'true' || configured === '1';
    res.cookie('access_token', token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: this.sessionCookieMaxAgeMs(),
    });
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
