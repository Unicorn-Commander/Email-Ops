import { resolveUserAccess, __resetAccessListCacheForTests } from './access-list';
import { WorkspaceRole } from '@prisma/client';

/**
 * The SSO access list gates "who can sign into Email-Ops at all" + the role on
 * first JIT (SUITE-IDENTITY §D5). Exact match wins; then domain wildcard; else
 * NOT authorized.
 */
describe('resolveUserAccess', () => {
  beforeEach(() => {
    __resetAccessListCacheForTests();
    process.env.EMAIL_OPS_ACCESS_LIST =
      'aaron@magicunicorn.tech:OWNER,shafenkhan@users.noreply.github.com:OWNER,*@magicunicorn.tech:MEMBER';
  });
  afterEach(() => {
    delete process.env.EMAIL_OPS_ACCESS_LIST;
    __resetAccessListCacheForTests();
  });

  it('exact match wins (OWNER)', () => {
    const r = resolveUserAccess('aaron@magicunicorn.tech');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe(WorkspaceRole.OWNER);
  });

  it('domain wildcard grants MEMBER', () => {
    const r = resolveUserAccess('someone@magicunicorn.tech');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe(WorkspaceRole.MEMBER);
  });

  it('a non-listed user is NOT authorized (the intentional gate)', () => {
    const r = resolveUserAccess('stranger@example.com');
    expect(r.allowed).toBe(false);
  });

  it('no email => not authorized', () => {
    expect(resolveUserAccess(undefined).allowed).toBe(false);
    expect(resolveUserAccess(null).allowed).toBe(false);
  });

  it('falls back to the legacy map when the env is unset', () => {
    delete process.env.EMAIL_OPS_ACCESS_LIST;
    __resetAccessListCacheForTests();
    const r = resolveUserAccess('aaron@magicunicorn.tech');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe(WorkspaceRole.OWNER);
  });
});
