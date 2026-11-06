import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { MailboxScope, MembershipStatus, WorkspaceRole } from '@prisma/client';
import { assertMayActThroughMailbox } from './mailbox-fence';
import { currentMailboxPrincipalScope } from './mailbox-principal';

export type MailboxScopeDb = Parameters<typeof resolveMailboxScope>[0];
export interface ResolvedMailboxScope {
  ids: string[];
  governed: boolean;
  unrestricted: boolean;
  /** True only when a non-empty PAT allowlist narrowed the normal user scope. */
  patScoped?: boolean;
}

/** Stable machine-readable denial for a PAT selecting a mailbox outside its allowlist. */
export class MailboxOutOfScopeException extends ForbiddenException {
  constructor() {
    super({
      statusCode: 403,
      error: 'Forbidden',
      code: 'mailbox_out_of_scope',
      message: 'mailbox_out_of_scope',
    });
  }
}

/**
 * The one mailbox visibility resolver used by human mail, MCP, and mailbox
 * management paths. `userKey` is the membership key (normally the Keycloak
 * subject; local User.id is accepted for the legacy/local auth path).
 *
 * A missing membership is deliberately treated as ungoverned. The guarded
 * request paths reject that caller when tenancy is enabled; this fallback keeps
 * the existing single-tenant/legacy service seams compatible while those paths
 * are exercised directly by workers and older tests.
 */
export async function resolveMailboxScope(
  db: {
    membership?: { findUnique: (args: any) => Promise<any>; findFirst?: (args: any) => Promise<any> };
    user?: { findFirst: (args: any) => Promise<{ id: string; keycloakId: string | null } | null> };
    mailboxAccount?: {
      findMany?: (args: any) => Promise<
        Array<{ id: string; ownerKind?: string; ownerKey?: string | null }> | undefined
      >;
    };
  },
  workspaceId: string,
  userKey: string | null,
): Promise<ResolvedMailboxScope> {
  const patScope = currentMailboxPrincipalScope();
  const narrowToPat = async (scope: ResolvedMailboxScope): Promise<ResolvedMailboxScope> => {
    if (!patScope || patScope.mailboxIds.length === 0) return scope;
    const allowed = new Set(patScope.mailboxIds);
    const rows =
      (await db.mailboxAccount?.findMany?.({
        where: { workspaceId, id: { in: scope.ids.filter((id) => allowed.has(id)) } },
        select: { id: true, ownerKind: true, ownerKey: true },
      })) ?? [];
    const callerKeys = new Set(keys);
    const currentlyUsable = new Set(
      rows
        .filter(
          (row) =>
            row.ownerKind !== 'HUMAN' ||
            (!!row.ownerKey && callerKeys.has(row.ownerKey)),
        )
        .map((row) => row.id),
    );
    return {
      ...scope,
      ids: scope.ids.filter((id) => allowed.has(id) && currentlyUsable.has(id)),
      governed: true,
      unrestricted: false,
      patScoped: true,
    };
  };
  const keys = new Set<string>();
  if (userKey?.trim()) keys.add(userKey.trim());
  if (userKey?.trim() && db.user?.findFirst) {
    const user = await db.user.findFirst({
      where: { OR: [{ keycloakId: userKey.trim() }, { id: userKey.trim() }] },
      select: { id: true, keycloakId: true },
    });
    if (user?.id) keys.add(user.id);
    if (user?.keycloakId) keys.add(user.keycloakId);
  }

  let membership: any = null;
  if (db.membership?.findUnique && userKey?.trim()) {
    membership = await db.membership.findUnique({
      where: { userKey_workspaceId: { userKey: userKey.trim(), workspaceId } },
      select: { role: true, status: true, mailboxScope: true, userKey: true },
    });
    if (!membership && db.membership.findFirst && keys.size > 1) {
      membership = await db.membership.findFirst({
        where: { workspaceId, userKey: { in: [...keys] } },
        select: { role: true, status: true, mailboxScope: true, userKey: true },
      });
    }
  }

  const all = async () => {
    const rows = (await db.mailboxAccount?.findMany?.({
      where: { workspaceId },
      select: { id: true },
    })) ?? [];
    return rows.map((row) => row.id);
  };

  // No membership is an auth-layer concern. Keep the old single-tenant service
  // behavior here; a guarded tenancy-on request never reaches this fallback.
  if (!membership)
    return narrowToPat({ ids: await all(), governed: false, unrestricted: true });
  if (membership.status !== MembershipStatus.ACTIVE) {
    return narrowToPat({ ids: [], governed: true, unrestricted: false });
  }

  // ADMIN/OWNER always retain workspace-wide visibility, independent of the
  // member's stored scope. ALL is the backwards-compatible default.
  if (
    membership.role === WorkspaceRole.ADMIN ||
    membership.role === WorkspaceRole.OWNER ||
    membership.mailboxScope === MailboxScope.ALL ||
    membership.mailboxScope == null
  ) {
    // `unrestricted`: workspace-wide visibility. These members also see agent-inbox
    // email drafts staged without a mailbox (a workspace that has not connected
    // one yet). OWNED members never do.
    return narrowToPat({ ids: await all(), governed: true, unrestricted: true });
  }

  // There is currently no human-manager relation for Agent rows. Agent.manager-
  // AgentKey is an agent-to-agent org-chart link, not a membership/user link,
  // so OWNED intentionally returns HUMAN mailboxes only until such a relation
  // exists.
  const owned = (await db.mailboxAccount?.findMany?.({
    where: {
      workspaceId,
      ownerKind: 'HUMAN',
      ownerKey: { in: [...keys] },
    },
    select: { id: true },
  })) ?? [];
  return narrowToPat({ ids: owned.map((row) => row.id), governed: true, unrestricted: false });
}

/** The public resolver named by the mailbox-scope contract. */
export async function visibleMailboxIds(
  db: Parameters<typeof resolveMailboxScope>[0],
  workspaceId: string,
  userKey: string | null,
): Promise<string[]> {
  return (await resolveMailboxScope(db, workspaceId, userKey)).ids;
}

/**
 * Guard an already-loaded mailbox for auxiliary mailbox surfaces (contacts,
 * signatures, vacation, rules, and management). Governed human members get a
 * 404 for an out-of-scope id; a mailbox-scoped PAT gets the stable 403. Every
 * caller, governed or not, still passes the HUMAN-owner fence
 * (ForbiddenException), exactly as on main: scope narrows access and never
 * widens it.
 */
export async function assertMailboxVisible(
  db: MailboxScopeDb,
  workspaceId: string,
  userKey: string | null,
  mailbox: { id: string; ownerKind: string; ownerKey: string | null },
): Promise<void> {
  const scope = await resolveMailboxScope(db, workspaceId, userKey);
  if (scope.governed && !scope.ids.includes(mailbox.id)) {
    if (scope.patScoped) throw new MailboxOutOfScopeException();
    throw new NotFoundException('Mailbox not found.');
  }
  await assertMayActThroughMailbox(
    db as unknown as { user: { findFirst: (args: any) => Promise<any> } },
    mailbox,
    userKey,
  );
}
