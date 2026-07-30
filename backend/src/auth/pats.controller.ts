/**
 * Personal Access Token management (SUITE-IDENTITY §D9).
 *
 *   POST   auth/pats      mint a new `eo_pat_...` token (shown once)
 *   GET    auth/pats      list the caller's tokens (non-secret fields only)
 *   DELETE auth/pats/:id  soft-revoke one of the caller's own tokens
 *
 * Guarded by JwtAuthGuard so minting/listing/revoking itself requires a real
 * login — a PAT cannot be used to bootstrap or manage other PATs (no
 * self-perpetuating credential chain). Every handler checks the
 * `__patAuth` marker the guard sets on a PAT-authenticated request and
 * rejects with 403 before doing anything else.
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  PatService,
  PAT_DAY_MS,
  PAT_DEFAULT_EXPIRY_DAYS,
  PAT_MAX_EXPIRY_DAYS,
} from './pat.service';

export class CreatePatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /**
   * REQUIRED — least privilege at mint. Omitting this no longer means `*`.
   * `*` and `prefix:*` are still values you may ask for deliberately.
   */
  @ApiProperty({
    description:
      'Required. Explicit scope list, e.g. ["mail:read"]. Pass ["*"] only if you deliberately want full reach.',
    example: ['mail:read', 'agent-inbox:read'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes!: string[];

  /**
   * Optional lifetime in days. Omitted → PAT_DEFAULT_EXPIRY_DAYS. A
   * never-expiring token cannot be minted at all.
   */
  @ApiProperty({
    required: false,
    description: `Lifetime in days (default ${PAT_DEFAULT_EXPIRY_DAYS}, maximum ${PAT_MAX_EXPIRY_DAYS}). A never-expiring token cannot be minted.`,
    minimum: 1,
    maximum: PAT_MAX_EXPIRY_DAYS,
    default: PAT_DEFAULT_EXPIRY_DAYS,
  })
  // ValidateIf (not IsOptional): class-validator's @IsOptional() also waves
  // through an explicit `null`, and `"expires_in_days": null` is exactly the
  // "never expires" request this fix exists to refuse. Only an ABSENT field
  // means "use the default".
  @ValidateIf((o: CreatePatDto) => o.expires_in_days !== undefined)
  @IsInt()
  @Min(1)
  @Max(PAT_MAX_EXPIRY_DAYS)
  expires_in_days?: number;
}

/** Throws 403 if the current request was itself authenticated via a PAT. */
function assertNotPatAuth(req: Request): void {
  const user = req.user as (User & { __patAuth?: boolean }) | undefined;
  if (user?.__patAuth) {
    throw new ForbiddenException(
      'Personal access tokens cannot be used to mint, list, or revoke other tokens',
    );
  }
}

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/pats')
@UseGuards(JwtAuthGuard)
export class PatsController {
  constructor(private readonly pats: PatService) {}

  @Post()
  @ApiOperation({ summary: 'Mint a new personal access token (plaintext shown once).' })
  @ApiResponse({ status: 201, description: 'The created token — `token` is shown exactly once.' })
  @ApiResponse({
    status: 400,
    description: 'Scopes omitted/empty, or an absent / out-of-range expiry.',
  })
  @ApiResponse({ status: 403, description: 'Caller authenticated via a PAT, not a real login.' })
  async create(@Req() req: Request, @CurrentUser() user: User, @Body() body: CreatePatDto) {
    assertNotPatAuth(req);
    // The ROUTE picks the default lifetime; PatService still demands an
    // explicit expiry so no code path can mint a forever token.
    const expiresAt =
      body.expires_in_days == null
        ? PatService.defaultExpiry()
        : new Date(Date.now() + body.expires_in_days * PAT_DAY_MS);
    const minted = await this.pats.createPat(user.id, body.name, {
      scopes: body.scopes,
      expiresAt,
    });
    return {
      id: minted.id,
      name: minted.name,
      token: minted.token,
      token_prefix: minted.tokenPrefix,
      scopes: minted.scopes,
      expires_at: minted.expiresAt,
      created_at: minted.createdAt,
    };
  }

  @Get()
  @ApiOperation({ summary: "List the caller's personal access tokens (non-secret fields only)." })
  @ApiResponse({ status: 200, description: 'The tokens.' })
  @ApiResponse({ status: 403, description: 'Caller authenticated via a PAT, not a real login.' })
  async list(@Req() req: Request, @CurrentUser() user: User) {
    assertNotPatAuth(req);
    const items = await this.pats.listPats(user.id);
    return {
      items: items.map((t) => ({
        id: t.id,
        name: t.name,
        token_prefix: t.tokenPrefix,
        last_used_at: t.lastUsedAt,
        created_at: t.createdAt,
        revoked_at: t.revokedAt,
      })),
    };
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: "Soft-revoke one of the caller's own personal access tokens." })
  @ApiResponse({ status: 204, description: 'Revoked.' })
  @ApiResponse({ status: 403, description: 'Caller authenticated via a PAT, not a real login.' })
  @ApiResponse({ status: 404, description: 'No such token owned by the caller.' })
  async revoke(@Req() req: Request, @CurrentUser() user: User, @Param('id') id: string): Promise<void> {
    assertNotPatAuth(req);
    await this.pats.revokePat(user.id, id);
  }
}
