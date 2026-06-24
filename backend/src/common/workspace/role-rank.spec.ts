import { WorkspaceRole } from '@prisma/client';
import { roleAtLeast, roleRank } from './role-rank';

describe('role-rank', () => {
  it('ranks the ladder VIEWER < MEMBER < MANAGER < ADMIN < OWNER', () => {
    const ladder: WorkspaceRole[] = ['VIEWER', 'MEMBER', 'MANAGER', 'ADMIN', 'OWNER'];
    for (let i = 1; i < ladder.length; i++) {
      expect(roleRank(ladder[i])).toBeGreaterThan(roleRank(ladder[i - 1]));
    }
  });

  it('roleAtLeast is inclusive + ordered', () => {
    expect(roleAtLeast('ADMIN', 'MANAGER')).toBe(true);
    expect(roleAtLeast('MANAGER', 'MANAGER')).toBe(true); // inclusive
    expect(roleAtLeast('MEMBER', 'MANAGER')).toBe(false);
    expect(roleAtLeast('OWNER', 'ADMIN')).toBe(true);
    expect(roleAtLeast('VIEWER', 'MEMBER')).toBe(false);
  });
});
