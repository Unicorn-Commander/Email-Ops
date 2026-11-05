#!/usr/bin/env node

/*
 * Map an Ops-Center organization to an existing Email-Ops workspace.
 *
 * Run from backend/ with the backend dependencies available:
 *   node -r ts-node/register ../scripts/map-org-to-workspace.ts <orgId> <workspaceId>
 *
 * The target must already have an active ADMIN or OWNER membership. The
 * database connection is the operator credential for this one-off control
 * action; no user or bearer credential is accepted or printed here.
 */

const {
  MembershipStatus,
  PrismaClient,
  WorkspaceRole,
} = require("../backend/node_modules/@prisma/client");

class MappingError extends Error {}

function usage(): never {
  throw new MappingError(
    "Usage: map-org-to-workspace.ts <orgId> <workspaceId>",
  );
}

function requiredArgument(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MappingError(`${name} must be a non-empty value`);
  }
  return value.trim();
}

async function main(): Promise<void> {
  const [rawOrgId, rawWorkspaceId, extra] = process.argv.slice(2);
  if (!rawOrgId || !rawWorkspaceId || extra) usage();

  const orgId = requiredArgument(rawOrgId, "orgId");
  const workspaceId = requiredArgument(rawWorkspaceId, "workspaceId");
  const prisma = new PrismaClient();

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        opsCenterOrgId: true,
        memberships: {
          where: {
            status: MembershipStatus.ACTIVE,
            role: { in: [WorkspaceRole.ADMIN, WorkspaceRole.OWNER] },
          },
          select: { userKey: true },
          take: 1,
        },
      },
    });
    if (!workspace)
      throw new MappingError(`Workspace ${workspaceId} was not found`);
    if (workspace.memberships.length === 0) {
      throw new MappingError(
        "Mapping requires an active ADMIN or OWNER membership on the target workspace",
      );
    }
    if (workspace.opsCenterOrgId && workspace.opsCenterOrgId !== orgId) {
      throw new MappingError(
        `Workspace ${workspaceId} is already mapped to Ops-Center org ${workspace.opsCenterOrgId}`,
      );
    }

    const existing = await prisma.workspace.findUnique({
      where: { opsCenterOrgId: orgId },
      select: { id: true },
    });
    if (existing && existing.id !== workspaceId) {
      throw new MappingError(
        `Ops-Center org ${orgId} is already mapped to workspace ${existing.id}`,
      );
    }

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { opsCenterOrgId: orgId },
    });
    console.log(
      `Mapped Ops-Center org ${orgId} to Email-Ops workspace ${workspaceId}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof MappingError) {
    console.error(error.message);
  } else {
    console.error("Mapping failed; database error details were not printed.");
  }
  process.exitCode = 1;
});
