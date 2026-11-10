import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Workspace } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type WorkspaceStatus = 'active' | 'suspended' | 'archived' | 'deleting';

export interface ProvisionWorkspaceInput {
  orgId: string;
  workspaceId?: string;
  slug?: string;
  displayName?: string;
  status?: WorkspaceStatus;
}

export interface PatchProvisionedWorkspaceInput {
  orgId: string;
  slug?: string;
  displayName?: string;
  status?: WorkspaceStatus;
}

export interface ProvisionedWorkspaceView {
  workspace_id: string;
  org_id: string;
  slug: string;
  display_name: string;
  status: string;
}

/** The Email-Ops side of the Ops-Center workspace mirror contract. */
@Injectable()
export class WorkspaceProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrGet(input: ProvisionWorkspaceInput): Promise<ProvisionedWorkspaceView> {
    const orgId = this.required(input.orgId, 'org_id');
    const existing = await this.findByOrgId(orgId);
    if (existing && existing.status !== 'active') {
      throw this.lifecycleProblem(existing, 'Workspace provisioning writes are disabled.');
    }

    const displayName =
      this.cleanDisplayName(input.displayName) || `Organization ${orgId.slice(0, 8)}`;
    const status = input.status ?? 'active';
    if (!existing) {
      const workspaceId = this.required(input.workspaceId || orgId, 'workspace_id');
      const slug = await this.uniqueSlug(
        this.cleanSlug(input.slug) || `org-${orgId.slice(0, 8).toLowerCase()}`,
      );
      try {
        const workspace = await this.prisma.workspace.create({
          data: {
            id: workspaceId,
            slug,
            displayName,
            opsCenterOrgId: orgId,
            status,
          },
        });
        return this.view(workspace, orgId);
      } catch (error) {
        if (this.isUniqueViolation(error)) {
          const winner = await this.findByOrgId(orgId);
          if (winner) return this.view(winner, orgId);
        }
        throw error;
      }
    }

    return this.view(existing, orgId);
  }

  async get(orgId: string): Promise<ProvisionedWorkspaceView> {
    const normalized = this.required(orgId, 'org_id');
    const workspace = await this.findByOrgId(normalized);
    if (!workspace)
      throw new NotFoundException('No provisioned workspace exists for this organization.');
    return this.view(workspace, normalized);
  }

  async list(): Promise<{ workspaces: ProvisionedWorkspaceView[] }> {
    const workspaces = await this.prisma.workspace.findMany({
      where: { opsCenterOrgId: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      workspaces: workspaces.map((workspace) => this.view(workspace, workspace.opsCenterOrgId!)),
    };
  }

  async patch(input: PatchProvisionedWorkspaceInput): Promise<ProvisionedWorkspaceView> {
    const orgId = this.required(input.orgId, 'org_id');
    const existing = await this.findByOrgId(orgId);
    if (!existing)
      throw new NotFoundException('No provisioned workspace exists for this organization.');

    // Ops-Center must be able to reactivate a suspended mirror, but an ordinary
    // metadata write must not use PATCH as a back door around app authorization.
    const changingMetadata = input.slug !== undefined || input.displayName !== undefined;
    if (existing.status !== 'active' && changingMetadata) {
      throw this.lifecycleProblem(existing, 'Workspace metadata writes are disabled.');
    }

    const data: Prisma.WorkspaceUpdateInput = {};
    if (input.slug !== undefined) data.slug = this.required(this.cleanSlug(input.slug), 'slug');
    if (input.displayName !== undefined) {
      data.displayName = this.required(this.cleanDisplayName(input.displayName), 'display_name');
    }
    if (input.status !== undefined) data.status = input.status;
    if (Object.keys(data).length === 0) return this.view(existing, orgId);

    try {
      const updated = await this.prisma.workspace.update({ where: { id: existing.id }, data });
      return this.view(updated, orgId);
    } catch (error) {
      if (this.isUniqueViolation(error))
        throw new ConflictException('That workspace slug is already in use.');
      throw error;
    }
  }

  private async findByOrgId(orgId: string): Promise<Workspace | null> {
    const mapped = await this.prisma.workspace.findUnique({ where: { opsCenterOrgId: orgId } });
    if (mapped) return mapped;
    // Preserve the P1-era mapping convention where an org UUID can also be the
    // canonical workspace id until Ops-Center supplies a separate workspace id.
    const byId = await this.prisma.workspace.findUnique({ where: { id: orgId } });
    if (!byId || byId.opsCenterOrgId === orgId) return byId;
    if (byId.opsCenterOrgId) return null;
    return this.prisma.workspace.update({
      where: { id: byId.id },
      data: { opsCenterOrgId: orgId },
    });
  }

  private async uniqueSlug(base: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await this.prisma.workspace.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    throw new ConflictException('Unable to allocate a unique workspace slug.');
  }

  private view(workspace: Workspace, orgId: string): ProvisionedWorkspaceView {
    return {
      workspace_id: workspace.id,
      org_id: orgId,
      slug: workspace.slug,
      display_name: workspace.displayName,
      status: workspace.status,
    };
  }

  private lifecycleProblem(workspace: Workspace, detail: string): ForbiddenException {
    return new ForbiddenException({
      type: 'https://docs.unicorncommander.ai/problems/workspace-inactive',
      title: 'Workspace is not active',
      status: 403,
      detail,
      workspace_id: workspace.id,
      workspace_status: workspace.status,
    });
  }

  private required(value: string | undefined | null, field: string): string {
    const cleaned = value?.trim();
    if (!cleaned) throw new ConflictException(`${field} is required.`);
    return cleaned;
  }

  private cleanSlug(value?: string): string | undefined {
    const cleaned = value?.trim().toLowerCase();
    if (cleaned && !/^[a-z0-9][a-z0-9-]{0,47}$/.test(cleaned)) {
      throw new ConflictException('slug may contain only lowercase letters, digits, and hyphens.');
    }
    return cleaned || undefined;
  }

  private cleanDisplayName(value?: string): string | undefined {
    const cleaned = value?.trim();
    return cleaned || undefined;
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002',
    );
  }
}
