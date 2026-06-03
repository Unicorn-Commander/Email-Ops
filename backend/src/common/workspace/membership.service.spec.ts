import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipStatus, User, WorkspaceRole } from '@prisma/client';
import { MembershipService } from './membership.service';
import { PrismaService } from '../../prisma/prisma.service';
import { __resetAccessListCacheForTests } from '../../auth/access-list';

const BOOTSTRAP = '0190a000-7e57-7000-8000-00000000e001';

/**
 * MembershipService is the workspace-access gate (SUITE-IDENTITY §D5). The
 * load-bearing guarantees pinned here:
 *   - Flag OFF (default) => total no-op: resolves to default, never throws,
 *     never touches membership. (Rollout-safety: nothing breaks today.)
 *   - Flag ON => membership gates: 403 without a membership; allow-listed
 *     users are seeded JIT into the bootstrap workspace; the requested
 *     workspace must be one the user belongs to.
 */
describe('MembershipService', () => {
  const aaron = {
    id: 'local-aaron',
    email: 'aaron@magicunicorn.tech',
    keycloakId: 'kc-aaron-sub',
  } as User;

  const stranger = {
    id: 'local-stranger',
    email: 'nobody@example.com',
    keycloakId: 'kc-stranger-sub',
  } as User;

  function make(env: Record<string, string | undefined>, prismaMock: any) {
    const config = {
      get: (k: string, def?: unknown) => (k in env ? env[k] : def),
    } as unknown as ConfigService;
    return new MembershipService(prismaMock as PrismaService, config);
  }

  beforeEach(() => {
    __resetAccessListCacheForTests();
    delete process.env.EMAIL_OPS_ACCESS_LIST; // legacy fallback (Aaron+Shafen OWNER)
  });

  describe('flag OFF (default)', () => {
    const prisma = { membership: {}, workspace: {} };

    it('resolveAndAuthorize returns the requested workspace without a membership check', async () => {
      const svc = make({ DEFAULT_WORKSPACE_ID: BOOTSTRAP }, prisma);
      await expect(svc.resolveAndAuthorize(aaron, 'W-requested')).resolves.toBe('W-requested');
    });

    it('falls back to the default workspace when none requested', async () => {
      const svc = make({ DEFAULT_WORKSPACE_ID: BOOTSTRAP }, prisma);
      await expect(svc.resolveAndAuthorize(aaron, null)).resolves.toBe(BOOTSTRAP);
    });

    it('never throws for a non-allow-listed user when the flag is off', async () => {
      const svc = make({ DEFAULT_WORKSPACE_ID: BOOTSTRAP }, prisma);
      await expect(svc.resolveAndAuthorize(stranger, null)).resolves.toBe(BOOTSTRAP);
    });
  });

  describe('flag ON', () => {
    const ON = { EMAIL_OPS_TENANCY_ENABLED: 'true', DEFAULT_WORKSPACE_ID: BOOTSTRAP };

    it('403s a user with no active membership (non-allow-listed, no seed)', async () => {
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(stranger, null)).rejects.toThrow(ForbiddenException);
      expect(prisma.membership.findMany).toHaveBeenCalled();
    });

    it('seeds an allow-listed user JIT, then resolves their default workspace', async () => {
      const created = {
        userKey: 'kc-aaron-sub',
        workspaceId: BOOTSTRAP,
        role: WorkspaceRole.OWNER,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      };
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(null), // no existing membership -> seed
          upsert: jest.fn().mockResolvedValue(created),
          findMany: jest.fn().mockResolvedValue([created]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(aaron, null)).resolves.toBe(BOOTSTRAP);
      expect(prisma.membership.upsert).toHaveBeenCalledTimes(1);
      const arg = prisma.membership.upsert.mock.calls[0][0];
      expect(arg.create.role).toBe(WorkspaceRole.OWNER); // access-list OWNER -> OWNER
      expect(arg.create.userKey).toBe('kc-aaron-sub'); // keyed by keycloakId/sub
    });

    it('403s when the requested workspace is not one the user belongs to', async () => {
      const member = {
        userKey: 'kc-aaron-sub',
        workspaceId: BOOTSTRAP,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      };
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(member),
          findMany: jest.fn().mockResolvedValue([member]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(aaron, 'SOME-OTHER-WS')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('allows the requested workspace when the user is a member of it', async () => {
      const member = {
        userKey: 'kc-aaron-sub',
        workspaceId: BOOTSTRAP,
        status: MembershipStatus.ACTIVE,
        isDefault: true,
      };
      const prisma = {
        membership: {
          findFirst: jest.fn().mockResolvedValue(member),
          findMany: jest.fn().mockResolvedValue([member]),
        },
        workspace: { findUnique: jest.fn().mockResolvedValue({ id: BOOTSTRAP }) },
      };
      const svc = make(ON, prisma);
      await expect(svc.resolveAndAuthorize(aaron, BOOTSTRAP)).resolves.toBe(BOOTSTRAP);
    });
  });

  describe('membershipKey + role mapping', () => {
    it('keys by keycloakId (uchub sub) when present, else local id', () => {
      expect(MembershipService.membershipKey({ id: 'L', keycloakId: 'kc' } as User)).toBe('kc');
      expect(MembershipService.membershipKey({ id: 'L', keycloakId: null } as User)).toBe('L');
    });

    it('passes canonical suite WorkspaceRoles through unchanged (SUITE-IDENTITY §7)', () => {
      expect(MembershipService.suiteRoleForAccess(WorkspaceRole.OWNER)).toBe(WorkspaceRole.OWNER);
      expect(MembershipService.suiteRoleForAccess(WorkspaceRole.MEMBER)).toBe(WorkspaceRole.MEMBER);
      expect(MembershipService.suiteRoleForAccess(WorkspaceRole.VIEWER)).toBe(WorkspaceRole.VIEWER);
    });
  });
});
