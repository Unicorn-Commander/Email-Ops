import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';

export type ApprovalUser = User & {
  __patAuth?: unknown;
  __isFederationActor?: boolean;
  __isFederationAuth?: boolean;
  __approvalSession?: { workspaceId: string; id: string };
};

type AgentLabelUser = ApprovalUser & {
  __federationActor?: unknown;
  username?: unknown;
  firstName?: unknown;
  lastName?: unknown;
};

/** PAT, federation-actor, and brigade/federation sessions. Never a caller-supplied flag. */
export function isAgentPrincipal(user: User | undefined): boolean {
  if (!user) return false;
  const identity = user as ApprovalUser;
  return !!(identity.__patAuth || identity.__isFederationActor || identity.__isFederationAuth);
}

/**
 * A display label for an agent-staged request. Federation actor id wins, then a
 * non-email username, then a non-email personal name. Never an email address.
 */
export function agentRequesterLabel(user: User): string {
  const identity = user as AgentLabelUser;
  const actor = typeof identity.__federationActor === 'string' ? identity.__federationActor.trim() : '';
  const username = typeof identity.username === 'string' ? identity.username.trim() : '';
  const fromUsername = username.startsWith('federation:') ? username.slice('federation:'.length) : username;
  const personal = [identity.firstName, identity.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim())
    .join(' ');
  const raw =
    actor ||
    (fromUsername && !fromUsername.includes('@') ? fromUsername : '') ||
    (personal && !personal.includes('@') ? personal : '') ||
    'agent';
  return raw.replace(/[\r\n]/g, ' ').slice(0, 200);
}

/** Use verified identity markers, never a caller-supplied "human" flag. */
export function assertHumanApproval(user: User | undefined): asserts user is ApprovalUser {
  if (!user) throw new UnauthorizedException('Sign in to review this approval.');
  if (isAgentPrincipal(user)) {
    throw new ForbiddenException('Only a signed-in human may manage approvals.');
  }
}
