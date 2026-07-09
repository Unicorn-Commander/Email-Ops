/**
 * Mailbox-management REST surface.
 *
 *   GET   workspaces/:workspaceId/mailboxes
 *   GET   workspaces/:workspaceId/mailboxes/:id
 *   POST  workspaces/:workspaceId/mailboxes            (CreateMailboxDto)
 *   PATCH workspaces/:workspaceId/mailboxes/:id         (UpdateMailboxDto)
 *
 * JWT + membership guarded. Writes gate through the provisioning policy: a HUMAN
 * mailbox uses humanMailbox.*, an AGENT mailbox (a send identity) uses
 * agentMailbox.* (ADMIN_ONLY by default). A self-owned human mailbox can use the
 * self-service escape. Reads are member-level.
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { IsBoolean, IsEnum, IsISO8601, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { MailboxOwnerKind, User, WorkspaceRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMembershipGuard } from '../common/workspace/workspace-membership.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ResolvedWorkspace } from '../common/workspace/resolved-workspace.decorator';
import { WorkspaceRoleParam } from '../common/workspace/workspace-role.decorator';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { ProvisionDecision } from '../provisioning/provisioning-policy';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { MailContactsService } from './mail-contacts.service';
import { MailVacationService } from './mail-vacation.service';
import { MailSignaturesService } from './mail-signatures.service';
import { MailboxAccountsService } from './mailbox-accounts.service';
import { CreateMailboxInput, UpdateMailboxInput } from './mailbox-accounts.types';

class CreateMailboxDto {
  @IsString() @MaxLength(320) email_address!: string;
  @IsOptional() @IsString() @MaxLength(200) display_name?: string;
  @IsOptional() @IsEnum(MailboxOwnerKind) owner_kind?: MailboxOwnerKind;
  @IsOptional() @IsString() @MaxLength(255) owner_key?: string;
  @IsOptional() @IsBoolean() postmark_lane?: boolean;
}

class ConnectMailboxDto {
  @IsIn(['gmail', 'microsoft']) provider!: 'gmail' | 'microsoft';
  // Optional hint; the backend resolves the AUTHORITATIVE address from the
  // provider via the broker token and only falls back to this if that fails.
  @IsOptional() @IsString() @MaxLength(320) email_address?: string;
  @IsOptional() @IsString() @MaxLength(200) display_name?: string;
}

class UpdateMailboxDto {
  @IsOptional() @IsString() @MaxLength(200) display_name?: string | null;
  @IsOptional() @IsEnum(MailboxOwnerKind) owner_kind?: MailboxOwnerKind;
  @IsOptional() @IsString() @MaxLength(255) owner_key?: string | null;
  @IsOptional() @IsBoolean() postmark_lane?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

class SaveSignatureDto {
  @IsString() @MaxLength(100) name!: string;
  @IsString() @MaxLength(50000) html!: string;
  @IsOptional() @IsBoolean() is_default?: boolean;
}

class UpdateSignatureDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(50000) html?: string;
  @IsOptional() @IsBoolean() is_default?: boolean;
}

class VacationSettingsDto {
  @IsBoolean() enabled!: boolean;
  @IsString() @MaxLength(300) subject!: string;
  @IsString() @MaxLength(50000) body_html!: string;
  @IsOptional() @IsISO8601() starts_at?: string | null;
  @IsOptional() @IsISO8601() ends_at?: string | null;
}

function normalizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
}

function htmlToText(html: string): string {
  return normalizeHtml(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<\/[^>]+>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

@ApiTags('mailboxes')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/mailboxes')
@UseGuards(JwtAuthGuard, WorkspaceMembershipGuard)
export class MailboxAccountsController {
  constructor(
    private readonly mailboxes: MailboxAccountsService,
    private readonly policy: ProvisioningPolicyService,
    private readonly mailProvider: MailProviderPort,
    private readonly signatures: MailSignaturesService,
    private readonly contacts: MailContactsService,
    private readonly vacation: MailVacationService,
  ) {}

  private blockIfApprovalGated(decision: ProvisionDecision, action: string): void {
    if (decision === 'requires_approval') {
      throw new ForbiddenException(
        `"${action}" requires approval under this workspace's policy; the approval workflow is being enabled.`,
      );
    }
  }

  @Get()
  @ApiOperation({ summary: 'List the workspace mailboxes (human / agent / shared).' })
  async list(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User) {
    const items = await this.mailboxes.listMailboxes(workspaceId, ucUidOf(user as WithWorkspaceClaim));
    return { items, count: items.length };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one mailbox.' })
  @ApiResponse({ status: 404, description: 'No such mailbox in this workspace.' })
  async get(@ResolvedWorkspace() workspaceId: string, @CurrentUser() user: User, @Param('id') id: string) {
    const mb = await this.mailboxes.getMailbox(workspaceId, ucUidOf(user as WithWorkspaceClaim), id);
    if (!mb) throw new NotFoundException('Mailbox not found in this workspace.');
    return mb;
  }

  @Get(':id/signatures')
  @ApiOperation({ summary: 'List reusable compose signatures for one mailbox.' })
  async listSignatures(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const items = await this.signatures.list(workspaceId, ucUidOf(user as WithWorkspaceClaim), id);
    return { items, count: items.length };
  }

  @Get(':id/vacation')
  @ApiOperation({ summary: 'Fetch the out-of-office settings for one mailbox.' })
  async getVacation(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    return this.vacation.get(workspaceId, ucUidOf(user as WithWorkspaceClaim), id);
  }

  @Get(':id/contacts')
  @ApiOperation({ summary: 'Search mailbox contacts for recipient autocomplete.' })
  async contactsSearch(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('q') q?: string,
  ) {
    const items = await this.contacts.search(workspaceId, ucUidOf(user as WithWorkspaceClaim), id, q ?? null);
    return { items, count: items.length };
  }

  @Post(':id/signatures')
  @ApiOperation({ summary: 'Create a compose signature for one mailbox.' })
  async createSignature(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: SaveSignatureDto,
  ) {
    if (!body.name.trim()) throw new BadRequestException('Signature name is required.');
    return this.signatures.create(workspaceId, ucUidOf(user as WithWorkspaceClaim), id, {
      name: body.name.trim(),
      html: normalizeHtml(body.html),
      isDefault: body.is_default,
    });
  }

  @Patch(':id/signatures/:signatureId')
  @ApiOperation({ summary: 'Update a compose signature for one mailbox.' })
  async updateSignature(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('signatureId') signatureId: string,
    @Body() body: UpdateSignatureDto,
  ) {
    if (body.name !== undefined && !body.name.trim()) {
      throw new BadRequestException('Signature name is required.');
    }
    return this.signatures.update(workspaceId, ucUidOf(user as WithWorkspaceClaim), id, signatureId, {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.html !== undefined ? { html: normalizeHtml(body.html) } : {}),
      ...(body.is_default !== undefined ? { isDefault: body.is_default } : {}),
    });
  }

  @Put(':id/vacation')
  @ApiOperation({ summary: 'Enable or disable the mailbox out-of-office auto-responder.' })
  async setVacation(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: VacationSettingsDto,
  ) {
    const subject = body.subject.trim();
    if (!subject) throw new BadRequestException('Vacation subject is required.');
    const bodyHtml = normalizeHtml(body.body_html);
    const startsAt = body.starts_at ? new Date(body.starts_at) : null;
    const endsAt = body.ends_at ? new Date(body.ends_at) : null;
    if (startsAt && Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException('starts_at must be a valid ISO date.');
    }
    if (endsAt && Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException('ends_at must be a valid ISO date.');
    }
    if (startsAt && endsAt && startsAt.getTime() > endsAt.getTime()) {
      throw new BadRequestException('starts_at must be before or equal to ends_at.');
    }
    return this.vacation.upsert(workspaceId, ucUidOf(user as WithWorkspaceClaim), id, {
      enabled: body.enabled,
      subject,
      bodyHtml,
      bodyText: htmlToText(bodyHtml),
      startsAt,
      endsAt,
    });
  }

  @Post(':id/signatures/:signatureId/default')
  @ApiOperation({ summary: 'Make one mailbox signature the default.' })
  async setDefaultSignature(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('signatureId') signatureId: string,
  ) {
    return this.signatures.setDefault(workspaceId, ucUidOf(user as WithWorkspaceClaim), id, signatureId);
  }

  @Delete(':id/signatures/:signatureId')
  @ApiOperation({ summary: 'Delete a compose signature.' })
  async deleteSignature(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('signatureId') signatureId: string,
  ) {
    return this.signatures.delete(workspaceId, ucUidOf(user as WithWorkspaceClaim), id, signatureId);
  }

  @Get(':id/connection')
  @ApiOperation({ summary: 'Fetch owner-scoped mail-client connection settings.' })
  @ApiResponse({ status: 403, description: 'Mailbox is not owned by the current user.' })
  @ApiResponse({ status: 404, description: 'No such mailbox in this workspace.' })
  async connection(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const settings = await this.mailboxes.getOwnConnectionSettings(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
    );
    if (!settings) throw new NotFoundException('Mailbox not found in this workspace.');
    return settings;
  }

  @Get(':id/config.mobileconfig')
  @ApiOperation({ summary: 'Download an owner-scoped Apple Mail configuration profile.' })
  @ApiResponse({ status: 403, description: 'Mailbox is not owned by the current user.' })
  @ApiResponse({ status: 404, description: 'No such mailbox in this workspace.' })
  async mobileconfig(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const profile = await this.mailboxes.buildOwnAppleMobileconfig(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
    );
    if (!profile) throw new NotFoundException('Mailbox not found in this workspace.');
    res.set({
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Disposition': `attachment; filename="${profile.filename}"`,
      'Content-Length': String(Buffer.byteLength(profile.xml)),
    });
    res.send(profile.xml);
  }

  @Post(':id/app-password\\:reset')
  @Throttle({ short: { ttl: 60000, limit: 3 }, long: { ttl: 3600000, limit: 12 } })
  @ApiOperation({ summary: 'Reset and reveal the owner-scoped mail app-password once.' })
  @ApiResponse({ status: 403, description: 'Mailbox is not owned by the current user.' })
  @ApiResponse({ status: 404, description: 'No such mailbox in this workspace.' })
  async resetAppPassword(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const result = await this.mailboxes.resetOwnAppPassword(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      id,
    );
    if (!result) throw new NotFoundException('Mailbox not found in this workspace.');
    return result;
  }

  @Post()
  @ApiOperation({ summary: 'Create a mailbox (human / agent / shared). Policy-gated by kind.' })
  @ApiResponse({ status: 201, description: 'The created mailbox.' })
  @ApiResponse({ status: 409, description: 'That address already exists here.' })
  async create(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Body() body: CreateMailboxDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    this.mailboxes.assertValidAddress(body.email_address);
    const ownerKind = body.owner_kind ?? MailboxOwnerKind.SHARED;
    const action = ownerKind === MailboxOwnerKind.AGENT ? 'agentMailbox.create' : 'humanMailbox.create';
    const isSelfOwnMailbox = ownerKind === MailboxOwnerKind.HUMAN && !!ucUid && body.owner_key === ucUid;
    const input: CreateMailboxInput = {
      emailAddress: body.email_address,
      displayName: body.display_name ?? null,
      ownerKind,
      ownerKey: body.owner_key ?? null,
      postmarkLane: body.postmark_lane,
    };
    const decision = await this.policy.authorize(workspaceId, ucUid, role, action, { isSelfOwnMailbox });
    if (decision === 'requires_approval') {
      // APPROVAL mode: file a request instead of applying; an approver replays it.
      const filed = await this.policy.fileRequest(workspaceId, ucUid, {
        kind: ownerKind === MailboxOwnerKind.AGENT ? 'AGENT_MAILBOX' : 'HUMAN_MAILBOX',
        action: 'create',
        payload: input,
        summary: `Create ${ownerKind.toLowerCase()} mailbox ${body.email_address}`,
      });
      return { provisioning_request: filed };
    }
    // Enforce the per-workspace cap (soft quota; the policy persists it).
    const policy = await this.policy.getEffectivePolicy(workspaceId, ucUid);
    if (
      policy.maxMailboxesPerWorkspace != null &&
      (await this.mailboxes.countMailboxes(workspaceId, ucUid)) >= policy.maxMailboxesPerWorkspace
    ) {
      throw new ConflictException(
        `This workspace has reached its mailbox limit (${policy.maxMailboxesPerWorkspace}).`,
      );
    }
    return this.mailboxes.createMailbox(workspaceId, ucUid, input);
  }

  @Post('connected')
  @ApiOperation({
    summary: 'Register a linked external account (gmail/microsoft) as a mailbox (self-service).',
  })
  @ApiResponse({ status: 201, description: 'The connected external mailbox.' })
  async connect(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @Body() body: ConnectMailboxDto,
  ) {
    // Self-service: the caller registers THEIR OWN linked account (ownerKind HUMAN,
    // ownerKey = their uchub sub). Member-level — no provisioning gate, since this
    // isn't minting a shared/agent send identity, just surfacing the user's own
    // connected mailbox. The OAuth token stays in the Keycloak broker.
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    if (!ucUid) throw new BadRequestException('No identity on the request.');
    // Resolve the AUTHORITATIVE provider address (so a Gmail/M365 that differs
    // from the login identity registers correctly); fall back to the client hint.
    const resolved = await this.mailProvider.resolveOwnAddress(body.provider, ucUid);
    const emailAddress = resolved ?? body.email_address;
    if (!emailAddress) {
      throw new BadRequestException(
        'Could not determine the account address — re-link the account, then try again.',
      );
    }
    this.mailboxes.assertValidAddress(emailAddress);
    return this.mailboxes.connectExternalMailbox(workspaceId, ucUid, {
      provider: body.provider,
      emailAddress,
      displayName: body.display_name ?? null,
    });
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a mailbox. Policy-gated by the mailbox kind.' })
  @ApiResponse({ status: 404, description: 'No such mailbox in this workspace.' })
  async update(
    @ResolvedWorkspace() workspaceId: string,
    @CurrentUser() user: User,
    @WorkspaceRoleParam() role: WorkspaceRole,
    @Param('id') id: string,
    @Body() body: UpdateMailboxDto,
  ) {
    const ucUid = ucUidOf(user as WithWorkspaceClaim);
    const existing = await this.mailboxes.getMailbox(workspaceId, ucUid, id);
    if (!existing) throw new NotFoundException('Mailbox not found in this workspace.');
    const action =
      existing.owner_kind === MailboxOwnerKind.AGENT ? 'agentMailbox.edit' : 'humanMailbox.edit';

    const patch: UpdateMailboxInput = {};
    if (body.display_name !== undefined) patch.displayName = body.display_name;
    if (body.owner_kind !== undefined) patch.ownerKind = body.owner_kind;
    if (body.owner_key !== undefined) patch.ownerKey = body.owner_key;
    if (body.postmark_lane !== undefined) patch.postmarkLane = body.postmark_lane;
    if (body.active !== undefined) patch.active = body.active;

    const decision = await this.policy.authorize(workspaceId, ucUid, role, action);
    if (decision === 'requires_approval') {
      const filed = await this.policy.fileRequest(workspaceId, ucUid, {
        kind: existing.owner_kind === MailboxOwnerKind.AGENT ? 'AGENT_MAILBOX' : 'HUMAN_MAILBOX',
        action: 'update',
        payload: { id, patch },
        summary: `Update mailbox ${existing.email_address}`,
      });
      return { provisioning_request: filed };
    }
    const updated = await this.mailboxes.updateMailbox(workspaceId, ucUid, id, patch);
    if (!updated) throw new NotFoundException('Mailbox not found in this workspace.');
    return updated;
  }
}
