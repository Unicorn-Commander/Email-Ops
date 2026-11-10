import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { OpsCenterServiceJwtGuard, ProvisioningEnabledGuard } from './workspace-provisioning.auth';
import {
  PatchProvisionedWorkspaceInput,
  ProvisionWorkspaceInput,
  WorkspaceProvisioningService,
  WorkspaceStatus,
} from './workspace-provisioning.service';

const WORKSPACE_STATUSES: WorkspaceStatus[] = ['active', 'suspended', 'archived', 'deleting'];

class ProvisionWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  org_id!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  workspace_id?: string;

  /** Accepted aliases keep the wire adapter compatible with Ops-Center docs. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(48)
  workspace_slug?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  workspace_name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(48)
  slug?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  display_name?: string;

  @IsOptional()
  @IsIn(WORKSPACE_STATUSES)
  status?: WorkspaceStatus;
}

class ProvisionWorkspaceQuery {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  org_id?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  org_uuid?: string;
}

class PatchProvisionWorkspaceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  org_id?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  org_uuid?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  workspace_id?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(48)
  workspace_slug?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  workspace_name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(48)
  slug?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  display_name?: string;

  @IsOptional()
  @IsIn(WORKSPACE_STATUSES)
  status?: WorkspaceStatus;
}

@ApiTags('provisioning')
@ApiBearerAuth()
@Controller('provisioning/workspaces')
@UseGuards(ProvisioningEnabledGuard, OpsCenterServiceJwtGuard)
export class WorkspaceProvisioningController {
  constructor(private readonly provisioning: WorkspaceProvisioningService) {}

  @Post()
  @ApiOperation({ summary: 'Provision or retrieve the Email-Ops workspace for an Ops-Center org.' })
  @ApiResponse({ status: 201, description: 'The idempotent workspace mirror.' })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or wrongly-audienced service JWT.' })
  @ApiResponse({ status: 403, description: 'Workspace is suspended or archived.' })
  async create(@Body() body: ProvisionWorkspaceDto) {
    const input: ProvisionWorkspaceInput = {
      orgId: body.org_id,
      workspaceId: body.workspace_id,
      slug: body.slug ?? body.workspace_slug,
      displayName: body.display_name ?? body.workspace_name,
      status: body.status,
    };
    return this.provisioning.createOrGet(input);
  }

  @Get()
  @ApiOperation({ summary: 'Read provisioned Email-Ops workspaces.' })
  @ApiResponse({ status: 200, description: 'The requested workspace, or all mapped workspaces.' })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or wrongly-audienced service JWT.' })
  async get(@Query() query: ProvisionWorkspaceQuery) {
    const orgId = query.org_id ?? query.org_uuid;
    return orgId ? this.provisioning.get(orgId) : this.provisioning.list();
  }

  @Patch()
  @ApiOperation({ summary: 'Patch the Ops-Center workspace mirror.' })
  @ApiResponse({ status: 200, description: 'The updated workspace mirror.' })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or wrongly-audienced service JWT.' })
  @ApiResponse({
    status: 403,
    description: 'Workspace metadata writes are disabled while inactive.',
  })
  async patch(@Body() body: PatchProvisionWorkspaceDto) {
    const input: PatchProvisionedWorkspaceInput = {
      orgId: body.org_id ?? body.org_uuid ?? body.workspace_id ?? '',
      slug: body.slug ?? body.workspace_slug,
      displayName: body.display_name ?? body.workspace_name,
      status: body.status,
    };
    return this.provisioning.patch(input);
  }
}
