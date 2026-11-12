import { isHumanMailSession } from './smtp-connection';
import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { Throttle } from '@nestjs/throttler';
import { User } from '@prisma/client';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { ExternalImapAccounts } from './external-imap.accounts';
import { externalImapEnabled, ImapConnection, requireExternalImap } from './imap-connection';

export class SmtpConnectDto {
  @IsString() @IsNotEmpty() @MaxLength(253) host!: string;
  @IsIn([465, 587]) port!: 465 | 587;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(320) username?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(1024) password?: string;
}

export class ImapConnectDto {
  @IsOptional() @ValidateNested() @Type(() => SmtpConnectDto) smtp?: SmtpConnectDto;
  @IsString() @IsNotEmpty() @MaxLength(253) host!: string;
  @IsInt() port!: number;
  @IsString() @IsNotEmpty() @MaxLength(320) username!: string;
  @IsString() @IsNotEmpty() @MaxLength(1024) password!: string;
  @IsIn(['tls', 'starttls', 'plaintext']) security!: 'tls';
  @IsEmail() @MaxLength(320) email_address!: string;
}

@Controller('workspaces/:workspaceId/external-imap')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class ExternalImapController {
  constructor(
    private readonly accounts: ExternalImapAccounts,
    private readonly connection: ImapConnection,
  ) {}

  @Get('capabilities')
  capabilities(@ResolvedWorkspace() workspaceId: string) {
    return { enabled: externalImapEnabled(workspaceId) };
  }

  private assertHuman(workspaceId: string, user: User & { __patAuth?: unknown }) {
    requireExternalImap(workspaceId);
    if (!isHumanMailSession(user))
      throw new ForbiddenException('Connect mailboxes through your signed-in session.');
  }

  @Post('test')
  @Throttle({ short: { ttl: 60000, limit: 5 }, long: { ttl: 3600000, limit: 30 } })
  test(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: ImapConnectDto,
  ) {
    this.assertHuman(workspaceId, user);
    return this.accounts.test(workspaceId, body);
  }

  @Post('connect')
  @Throttle({ short: { ttl: 60000, limit: 5 }, long: { ttl: 3600000, limit: 30 } })
  connect(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: ImapConnectDto,
  ) {
    this.assertHuman(workspaceId, user);
    return this.accounts.connect(workspaceId, user, body);
  }

  @Post(':mailboxId/disconnect')
  @Throttle({ short: { ttl: 60000, limit: 5 }, long: { ttl: 3600000, limit: 30 } })
  disconnect(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('mailboxId') mailboxId: string,
  ) {
    this.assertHuman(workspaceId, user);
    return this.accounts.disconnect(workspaceId, user, mailboxId);
  }
}
