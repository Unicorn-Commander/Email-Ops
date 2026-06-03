import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../../prisma/prisma.service';
import { MembershipService } from './membership.service';
import {
  DEFAULT_WORKSPACE_FALLBACK,
  resolveWorkspaceId,
  ucUidOf,
  WithWorkspaceClaim,
} from './workspace.util';

/**
 * Injectable wrapper around the workspace resolution seam, for services and
 * the REST layer. See workspace.util.ts for the full rationale.
 *
 * This is the app-layer half of the GUC chokepoint: the workspace id it
 * resolves (claim → default, gated by membership when tenancy is on) is the
 * exact value fed into PrismaService.withWorkspace, so the DB Row Level
 * Security GUC is always whatever this service decided. The columns, indices,
 * and RLS policies are already workspace-ready; this is the ONE place app-layer
 * resolution meets the database fence.
 */
@Injectable()
export class WorkspaceContextService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly membership: MembershipService,
  ) {}

  get defaultWorkspaceId(): string {
    return this.config.get<string>('DEFAULT_WORKSPACE_ID', DEFAULT_WORKSPACE_FALLBACK);
  }

  /** Resolve the active workspace id for the given (claim-augmented) user. */
  resolve(user: Partial<WithWorkspaceClaim> | null | undefined): string {
    return resolveWorkspaceId(user, this.defaultWorkspaceId);
  }

  /**
   * Resolve the active workspace for `user` AND authorize membership (a no-op
   * while EMAIL_OPS_TENANCY_ENABLED is off — see MembershipService). Use this
   * on workspace-scoped request paths; it 403s when tenancy is live and the
   * user has no membership in the resolved workspace.
   */
  async resolveAuthorized(
    user: User & Partial<WithWorkspaceClaim>,
    requestedWorkspaceId?: string | null,
  ): Promise<string> {
    const claim = requestedWorkspaceId ?? this.resolve(user);
    return this.membership.resolveAndAuthorize(user, claim);
  }

  /**
   * Run `fn` inside the resolved workspace's RLS transaction. Resolves the
   * workspace id from the user's claim (authorizing membership when tenancy is
   * on), pins the `app.current_workspace` + `app.uc_uid` GUCs via
   * PrismaService.withWorkspace, and invokes `fn(tx)`.
   *
   *   workspaceContext.runForUser(user, (tx) => tx.emailMessage.findMany());
   *
   * This is the recommended call shape for any service that needs tenant-scoped
   * DB access: it guarantees the DB GUC matches the app-layer decision.
   */
  async runForUser<T>(
    user: User & Partial<WithWorkspaceClaim>,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
    requestedWorkspaceId?: string | null,
  ): Promise<T> {
    const workspaceId = await this.resolveAuthorized(user, requestedWorkspaceId);
    return this.prisma.withWorkspace(workspaceId, ucUidOf(user), fn);
  }

  /**
   * Lower-level: run `fn` inside an explicit workspace's RLS transaction. For
   * system jobs / already-resolved workspace ids that don't carry a request user.
   */
  async runInWorkspace<T>(
    workspaceId: string,
    ucUid: string | null | undefined,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withWorkspace(workspaceId, ucUid, fn);
  }
}
