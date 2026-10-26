import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';

export type ApprovalUser = User & {
  __patAuth?: unknown;
  __isFederationActor?: boolean;
  __isFederationAuth?: boolean;
  __approvalSession?: { workspaceId: string; id: string };
};

/** Use verified identity markers, never a caller-supplied "human" flag. */
export function assertHumanApproval(user: User | undefined): asserts user is ApprovalUser {
  if (!user) throw new UnauthorizedException('Sign in to review this approval.');
  const identity = user as ApprovalUser;
  if (identity.__patAuth || identity.__isFederationActor || identity.__isFederationAuth) {
    throw new ForbiddenException('Only a signed-in human may manage approvals.');
  }
}
