import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { ucUidOf } from '../common/workspace/workspace.util';
import { ApprovalTokensService } from './approval-tokens.service';
import { ApprovalUser, assertHumanApproval } from './human-approval';
import { DAY_MS, sha256 } from './standing-approval';

export const APPROVAL_COOKIE = 'eo_approval_session';
export const APPROVAL_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict' as const,
  path: '/api/v1/approvals',
};

export function cookieValue(header: string | undefined, name: string): string | null {
  const value = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!value) return null;
  try {
    return decodeURIComponent(value.slice(name.length + 1));
  } catch {
    return null;
  }
}

@Injectable()
export class ApprovalSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: ApprovalTokensService,
  ) {}

  async create(workspaceId: string, user: User, tx?: WorkspaceTxClient): Promise<string> {
    assertHumanApproval(user);
    if (user.__approvalSession)
      throw new ForbiddenException('Sign in again to extend an approval session.');
    const nonce = randomBytes(32).toString('base64url');
    const now = new Date();
    const id = sha256(nonce);
    const save = (client: WorkspaceTxClient) =>
      client.approvalSession.create({
        data: {
          id,
          workspaceId,
          userId: user.id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 30 * DAY_MS),
        },
      });
    if (tx) await save(tx);
    else await this.prisma.withWorkspace(workspaceId, ucUidOf(user), save);
    return this.tokens.sign('session', { workspaceId, nonce });
  }

  async resolve(token: string): Promise<ApprovalUser> {
    const { workspaceId, nonce } = this.tokens.verify<{ workspaceId: string; nonce: string }>(
      'session',
      token,
    );
    if (typeof workspaceId !== 'string' || typeof nonce !== 'string')
      throw new UnauthorizedException('Invalid approval session.');
    return this.prisma.withWorkspace(workspaceId, null, async (tx) => {
      const session = await tx.approvalSession.findFirst({
        where: {
          id: sha256(nonce),
          workspaceId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!session) throw new UnauthorizedException('Sign in again to approve.');
      const user = await tx.user.findUnique({ where: { id: session.userId } });
      if (!user?.isActive) throw new UnauthorizedException('User not found or inactive.');
      return { ...user, __approvalSession: { workspaceId, id: session.id } };
    });
  }

  async revoke(user: ApprovalUser): Promise<void> {
    if (!user.__approvalSession) return;
    const { workspaceId, id } = user.__approvalSession;
    await this.prisma.withWorkspace(workspaceId, ucUidOf(user), (tx) =>
      tx.approvalSession.updateMany({
        where: { id, workspaceId, userId: user.id },
        data: { revokedAt: new Date() },
      }),
    );
  }

  async revokeToken(token: string | null, user: ApprovalUser): Promise<void> {
    if (!token) return;
    let session: ApprovalUser;
    try {
      session = await this.resolve(token);
    } catch (error) {
      if (error instanceof UnauthorizedException) return;
      throw error;
    }
    if (session.id !== user.id) throw new ForbiddenException('Different approval session owner.');
    await this.revoke(session);
  }
}
