import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Membership, MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveUserAccess } from '../../auth/access-list';
import { tenancyEnabled } from './feature-flags';
import { DEFAULT_WORKSPACE_FALLBACK } from './workspace.util';

/**
 * Workspace membership resolution + gating (SUITE-IDENTITY §3, §D5).
 *
 * The cross-app contract: a valid uchub token JIT-provisions the User row, but
 * grants ZERO workspace access until an explicit Membership row exists. The
 * allow-list (EMAIL_OPS_ACCESS_LIST) is a membership-SEEDING convenience — NOT
 * "the tenant". Membership is what gates.
 *
 * Rollout-safety: every gate here is a no-op while EMAIL_OPS_TENANCY_ENABLED is
 * off (its default). With the flag off, callers fall back to
 * DEFAULT_WORKSPACE_ID exactly as before. With the flag on, workspace routes
 * 403 without an active membership and the membership-derived workspace drives
 * the RLS GUC.
 */
@Injectable()
export class MembershipService {
  private readonly logger = new Logger(MembershipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get enabled(): boolean {
    return tenancyEnabled((k) => this.config.get<string>(k));
  }

  /** The single bootstrap/dogfood workspace id seeded by the RLS migration. */
  get bootstrapWorkspaceId(): string {
    return this.config.get<string>('DEFAULT_WORKSPACE_ID', DEFAULT_WORKSPACE_FALLBACK);
  }

  /**
   * The membership key for a user == uchub `sub` == User.keycloakId. Local
   * (non-SSO) users have no keycloakId; their membership key falls back to the
   * local user id so the dogfood seed still resolves.
   */
  static membershipKey(user: Pick<User, 'id' | 'keycloakId'>): string {
    return user.keycloakId ?? user.id;
  }

  /**
   * Load the workspace mirror rows for a set of ids (display fields for the
   * list_my_workspaces projection). Read-through accessor so callers don't need
   * their own Prisma dependency.
   */
  async findWorkspaces(ids: string[]) {
    if (ids.length === 0) return [];
    return this.prisma.workspace.findMany({ where: { id: { in: ids } } });
  }

  /** All ACTIVE memberships for a user (keyed by sub/keycloakId or local id). */
  async listActiveMemberships(user: Pick<User, 'id' | 'keycloakId'>): Promise<Membership[]> {
    const userKey = MembershipService.membershipKey(user);
    return this.prisma.membership.findMany({
      where: { userKey, status: MembershipStatus.ACTIVE },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /** True iff the user has an ACTIVE membership in `workspaceId`. */
  async isActiveMember(
    user: Pick<User, 'id' | 'keycloakId'>,
    workspaceId: string,
  ): Promise<boolean> {
    const userKey = MembershipService.membershipKey(user);
    const m = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey, workspaceId } },
    });
    return !!m && m.status === MembershipStatus.ACTIVE;
  }

  /**
   * Resolve the workspace a request should run in for `user`, and ensure the
   * user is an active member of it.
   *
   *  - Flag OFF (default): returns the requested/default workspace WITHOUT a
   *    membership check (today's single-tenant behavior, never throws).
   *  - Flag ON: the user must have an active membership; an allow-listed user
   *    with no membership is seeded JIT into the bootstrap workspace; anyone
   *    else gets a 403. The requested workspace (path/header/claim) must be one
   *    the user actually belongs to, else 403.
   *
   * @param requestedWorkspaceId optional explicit target (from path/header/claim).
   */
  async resolveAndAuthorize(user: User, requestedWorkspaceId?: string | null): Promise<string> {
    const fallback = this.bootstrapWorkspaceId;

    if (!this.enabled) {
      // Inert: behave exactly as before — claim/requested wins, else default.
      return requestedWorkspaceId?.trim() || fallback;
    }

    // Tenancy live: membership gates. Seed allow-listed users JIT.
    await this.ensureSeededMembership(user);

    const memberships = await this.listActiveMemberships(user);
    if (memberships.length === 0) {
      this.logger.warn(
        `403 workspace access for ${user.email} (${MembershipService.membershipKey(user)}): no active membership`,
      );
      throw new ForbiddenException('No workspace access for this user.');
    }

    if (requestedWorkspaceId?.trim()) {
      const target = requestedWorkspaceId.trim();
      if (!memberships.some((m) => m.workspaceId === target)) {
        this.logger.warn(`403 workspace access for ${user.email}: not a member of ${target}`);
        throw new ForbiddenException('Not a member of the requested workspace.');
      }
      return target;
    }

    // No explicit target: the default membership, else the first.
    const def = memberships.find((m) => m.isDefault) ?? memberships[0];
    return def.workspaceId;
  }

  /**
   * Like resolveAndAuthorize, but ALSO surfaces the caller's role in the resolved
   * workspace — the role the bare resolve discards, which the provisioning RBAC
   * gates need. Flag OFF → role OWNER (the single-tenant operator keeps full
   * power; nothing tightens until the flag flips). Flag ON → the membership's
   * role (VIEWER if somehow unmapped — fail-closed).
   */
  async resolveWithRole(
    user: User,
    requestedWorkspaceId?: string | null,
  ): Promise<{ workspaceId: string; role: WorkspaceRole }> {
    const workspaceId = await this.resolveAndAuthorize(user, requestedWorkspaceId);
    if (!this.enabled) {
      return { workspaceId, role: WorkspaceRole.OWNER };
    }
    const userKey = MembershipService.membershipKey(user);
    const m = await this.prisma.membership.findUnique({
      where: { userKey_workspaceId: { userKey, workspaceId } },
    });
    return { workspaceId, role: m?.role ?? WorkspaceRole.VIEWER };
  }

  /**
   * If `user` is on the SSO allow-list but has no membership yet, seed one into
   * the bootstrap workspace at the role mapped from their access-list role.
   * Idempotent. Only runs when tenancy is enabled.
   */
  async ensureSeededMembership(user: User): Promise<void> {
    if (!this.enabled) return;
    const userKey = MembershipService.membershipKey(user);

    const existing = await this.prisma.membership.findFirst({ where: { userKey } });
    if (existing) return;

    const access = resolveUserAccess(user.email);
    if (!access.allowed) return; // not allow-listed -> no seed; gate will 403.

    const workspaceId = this.bootstrapWorkspaceId;
    // Only seed if the bootstrap workspace actually exists locally.
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) {
      this.logger.warn(
        `Cannot seed membership for ${user.email}: bootstrap workspace ${workspaceId} not present`,
      );
      return;
    }

    const role = MembershipService.suiteRoleForAccess(access.role);
    await this.prisma.membership.upsert({
      where: { userKey_workspaceId: { userKey, workspaceId } },
      update: {},
      create: {
        userKey,
        workspaceId,
        role,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      },
    });
    this.logger.log(
      `Seeded ${role} membership for ${user.email} in workspace ${workspaceId} (allow-list)`,
    );
  }

  /**
   * Resolve the canonical suite WorkspaceRole to seed (SUITE-IDENTITY §7).
   * Email-Ops' access list already returns canonical suite roles, so this is
   * the identity — kept as an explicit seam so the call site reads the same as
   * the rest of the suite (which map an app-local role here).
   */
  static suiteRoleForAccess(role: WorkspaceRole): WorkspaceRole {
    return role;
  }
}
