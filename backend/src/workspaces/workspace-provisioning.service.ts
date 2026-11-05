import { Injectable, Logger } from '@nestjs/common';
import {
  Membership,
  MembershipStatus,
  Prisma,
  User,
  Workspace,
  WorkspaceRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipService } from '../common/workspace/membership.service';
import { roleRank } from '../common/workspace/role-rank';

export interface EntitledWorkspaceEntitlement {
  orgId: string;
  orgName?: string | null;
  tier?: string | null;
  role?: string | null;
  entitlements?: string[];
}

export interface EnsureEntitledWorkspaceRequest {
  user: User;
  entitlement: EntitledWorkspaceEntitlement;
}

export interface EnsureEntitledWorkspaceResult {
  workspaceId: string;
  workspace: Workspace;
  membership: Membership;
}

/**
 * Materializes the Ops-Center organization mirror in Email-Ops.
 *
 * The Ops-Center org id is the idempotency key and the workspace id. This
 * service only writes that workspace and the caller's membership; it never
 * renames an existing mirror or changes memberships in another workspace.
 */
@Injectable()
export class WorkspaceProvisioningService {
  private readonly logger = new Logger(WorkspaceProvisioningService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ensureEntitledWorkspace(
    request: EnsureEntitledWorkspaceRequest,
  ): Promise<EnsureEntitledWorkspaceResult> {
    const orgId = request.entitlement.orgId?.trim();
    if (!orgId) throw new Error('Entitled organization id is required');

    const userKey = MembershipService.membershipKey(request.user);
    if (!userKey) throw new Error('Entitled workspace membership key is required');

    const id8 = orgId.slice(0, 8);
    const baseSlug = `org-${id8.toLowerCase()}`;
    const displayName = request.entitlement.orgName?.trim() || `Organization ${id8}`;
    const desiredRole =
      request.entitlement.role?.trim().toLowerCase() === 'owner'
        ? WorkspaceRole.OWNER
        : WorkspaceRole.MEMBER;

    // A concurrent first login can race on either the org primary key, the
    // global slug, or the composite membership key. Replaying the idempotent
    // transaction lets the winner's rows become the inputs for this request.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) =>
          this.materialize(tx, {
            orgId,
            baseSlug,
            displayName,
            userKey,
            desiredRole,
          }),
        );
      } catch (error) {
        if (!this.isUniqueViolation(error) || attempt === 2) throw error;
      }
    }

    throw new Error('Entitled workspace provisioning did not complete');
  }

  private async materialize(
    tx: Prisma.TransactionClient,
    fields: {
      orgId: string;
      baseSlug: string;
      displayName: string;
      userKey: string;
      desiredRole: WorkspaceRole;
    },
  ): Promise<EnsureEntitledWorkspaceResult> {
    const existing = await tx.workspace.findUnique({ where: { id: fields.orgId } });
    const slug = existing?.slug ?? (await this.uniqueSlug(tx, fields.baseSlug));
    const workspace = await tx.workspace.upsert({
      where: { id: fields.orgId },
      update: {},
      create: {
        id: fields.orgId,
        slug,
        displayName: fields.displayName,
      },
    });

    const existingMembership = await tx.membership.findUnique({
      where: {
        userKey_workspaceId: {
          userKey: fields.userKey,
          workspaceId: fields.orgId,
        },
      },
    });

    let membership: Membership;
    if (existingMembership) {
      const role =
        roleRank(existingMembership.role) >= roleRank(fields.desiredRole)
          ? existingMembership.role
          : fields.desiredRole;
      const update: Prisma.MembershipUpdateInput = {};
      if (role !== existingMembership.role) update.role = role;
      if (existingMembership.status !== MembershipStatus.ACTIVE) {
        update.status = MembershipStatus.ACTIVE;
      }
      membership = Object.keys(update).length
        ? await tx.membership.update({
            where: {
              userKey_workspaceId: {
                userKey: fields.userKey,
                workspaceId: fields.orgId,
              },
            },
            data: update,
          })
        : existingMembership;
    } else {
      const hasAnyMembership = await tx.membership.findFirst({
        where: { userKey: fields.userKey },
        select: { workspaceId: true },
      });
      membership = await tx.membership.create({
        data: {
          userKey: fields.userKey,
          workspaceId: fields.orgId,
          role: fields.desiredRole,
          status: MembershipStatus.ACTIVE,
          isDefault: !hasAnyMembership,
        },
      });
    }

    this.logger.log(
      `Ensured entitled workspace ${fields.orgId} for membership ${fields.userKey} (${membership.role})`,
    );
    return { workspaceId: fields.orgId, workspace, membership };
  }

  private async uniqueSlug(tx: Prisma.TransactionClient, base: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const taken = await tx.workspace.findUnique({ where: { slug: candidate } });
      if (!taken) return candidate;
    }
    throw new Error(`Unable to allocate a unique workspace slug for ${base}`);
  }

  private isUniqueViolation(error: unknown): boolean {
    return Boolean(
      error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002',
    );
  }
}
