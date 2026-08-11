/**
 * The startup assertion that a missing federation principal can no longer be
 * mistaken for "no data".
 *
 * The cases that matter are the EXCEPTIONS: an app can legitimately have no
 * principal row (nobody federates into that workspace), and can legitimately
 * have rows for actors that are not allow-listed (another app's guard falls
 * through to the membership path). A check that erred on those would be noise,
 * and noise is how the original bug survived.
 */

import { MembershipStatus } from '@prisma/client';
import {
  FederationPrincipalCheck,
  parseActors,
  parseRequiredPairs,
} from './federation-principal.check';

const WS_MU = '0190a000-7e57-7000-8000-00000000e001';
const WS_GFL = '79aefb60-16fc-4092-9230-3a667eb5226f';
const WS_fabrikam = 'aedf0ea2-9d2f-44e9-9026-265d0eb46429';

const WORKSPACES = [
  { id: WS_MU, slug: 'magic-unicorn' },
  { id: WS_GFL, slug: 'brightwater-labs' },
  { id: WS_fabrikam, slug: 'fabrikam-design' },
];

function makeCheck(rows: { userKey: string; workspaceId: string; status?: MembershipStatus }[]) {
  const prisma = {
    workspace: { findMany: jest.fn().mockResolvedValue(WORKSPACES) },
    membership: {
      findMany: jest.fn().mockResolvedValue(
        rows.map((r) => ({ ...r, status: r.status ?? MembershipStatus.ACTIVE })),
      ),
    },
  } as any;
  return new FederationPrincipalCheck(prisma);
}

const ENV_ACTORS = 'EMAIL_OPS_FEDERATION_ACTORS';
const ENV_REQUIRED = 'EMAIL_OPS_FEDERATION_REQUIRED_WORKSPACES';

describe('parseRequiredPairs / parseActors', () => {
  it('parses actor:workspace pairs and tolerates whitespace + empties', () => {
    expect(parseRequiredPairs('customer-ops:magic-unicorn, customer-ops:brightwater-labs ,')).toEqual([
      { actor: 'customer-ops', workspace: 'magic-unicorn' },
      { actor: 'customer-ops', workspace: 'brightwater-labs' },
    ]);
  });

  it('splits on the LAST colon so a UUID workspace still parses', () => {
    expect(parseRequiredPairs(`customer-ops:${WS_MU}`)).toEqual([
      { actor: 'customer-ops', workspace: WS_MU },
    ]);
  });

  it('drops malformed entries rather than inventing a pair', () => {
    expect(parseRequiredPairs('no-colon, :leading, trailing:')).toEqual([]);
    expect(parseRequiredPairs(undefined)).toEqual([]);
  });

  it('parses the actor allow-list', () => {
    expect(parseActors(' customer-ops , meeting-ops ')).toEqual(['customer-ops', 'meeting-ops']);
    expect(parseActors('')).toEqual([]);
  });
});

describe('FederationPrincipalCheck', () => {
  const saved = { actors: process.env[ENV_ACTORS], required: process.env[ENV_REQUIRED] };
  afterEach(() => {
    process.env[ENV_ACTORS] = saved.actors;
    process.env[ENV_REQUIRED] = saved.required;
    if (saved.actors === undefined) delete process.env[ENV_ACTORS];
    if (saved.required === undefined) delete process.env[ENV_REQUIRED];
    jest.restoreAllMocks();
  });

  it('THE REGRESSION: a required pair with no row is reported as missing, by name', async () => {
    process.env[ENV_ACTORS] = 'customer-ops';
    process.env[ENV_REQUIRED] = 'customer-ops:magic-unicorn,customer-ops:brightwater-labs';
    // magic-unicorn has the row; brightwater-labs does NOT — the exact 2026-08-11 state.
    const check = makeCheck([{ userKey: 'federation:customer-ops', workspaceId: WS_MU }]);

    const s = await check.run();

    expect(s.missingRequired).toHaveLength(1);
    expect(s.missingRequired[0]).toMatchObject({
      actor: 'customer-ops',
      workspaceId: WS_GFL,
      workspaceSlug: 'brightwater-labs',
      kind: 'missing',
      detail: 'no principal row',
    });
  });

  it('logs the missing pair at ERROR with the actor, the workspace and the fix', async () => {
    process.env[ENV_ACTORS] = 'customer-ops';
    process.env[ENV_REQUIRED] = 'customer-ops:brightwater-labs';
    const check = makeCheck([]);
    const err = jest.spyOn((check as any).logger, 'error').mockImplementation(() => undefined);

    await check.run();

    const joined = err.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joined).toContain('FEDERATION PRINCIPAL MISSING');
    expect(joined).toContain('customer-ops');
    expect(joined).toContain('brightwater-labs');
    // The whole point: say it will look like "no data", and say how to fix it.
    expect(joined).toMatch(/empty panel/i);
    expect(joined).toContain('INSERT INTO memberships');
  });

  it('treats a SUSPENDED row as missing, not as present', async () => {
    process.env[ENV_ACTORS] = 'customer-ops';
    process.env[ENV_REQUIRED] = 'customer-ops:magic-unicorn';
    const check = makeCheck([
      { userKey: 'federation:customer-ops', workspaceId: WS_MU, status: MembershipStatus.SUSPENDED },
    ]);

    const s = await check.run();

    expect(s.missingRequired).toHaveLength(1);
    expect(s.missingRequired[0].detail).toMatch(/status=SUSPENDED/);
  });

  it('is CLEAN when every required pair is present (and stays quiet about the rest)', async () => {
    process.env[ENV_ACTORS] = 'customer-ops';
    process.env[ENV_REQUIRED] = 'customer-ops:magic-unicorn,customer-ops:brightwater-labs';
    const check = makeCheck([
      { userKey: 'federation:customer-ops', workspaceId: WS_MU },
      { userKey: 'federation:customer-ops', workspaceId: WS_GFL },
    ]);

    const s = await check.run();

    expect(s.missingRequired).toEqual([]);
    expect(s.unlistedActorRows).toEqual([]);
    // EXCEPTION 1: fabrikam-design has no Customer-Ops mapping, so its absence is
    // informational — NOT a failure. Erring here would train people to ignore this.
    expect(s.absentOptional).toEqual([{ actor: 'customer-ops', workspaceSlug: 'fabrikam-design' }]);
  });

  it('EXCEPTION 2: a row for a NON-allow-listed actor warns, and never fails', async () => {
    // This is the Project-Ops shape: federation:customer-ops rows exist while
    // customer-ops is absent from the actor allow-list. A naive fail-closed check
    // would break that seam instantly, so it must warn only.
    process.env[ENV_ACTORS] = 'meeting-ops';
    process.env[ENV_REQUIRED] = '';
    const check = makeCheck([{ userKey: 'federation:customer-ops', workspaceId: WS_MU }]);

    const s = await check.run();

    expect(s.missingRequired).toEqual([]);
    expect(s.unlistedActorRows).toHaveLength(1);
    expect(s.unlistedActorRows[0]).toMatchObject({
      actor: 'customer-ops',
      workspaceSlug: 'magic-unicorn',
      kind: 'unlisted-actor',
    });
  });

  it('EXCEPTION 3: an allow-listed actor with NO required pairs never fails — it warns that nothing is asserted', async () => {
    // The Project-Ops meeting-ops shape: allow-listed, no rows anywhere, and that
    // is correct because its guard bypasses membership on the ingest routes.
    process.env[ENV_ACTORS] = 'meeting-ops';
    delete process.env[ENV_REQUIRED];
    const check = makeCheck([]);
    const warn = jest.spyOn((check as any).logger, 'warn').mockImplementation(() => undefined);

    const s = await check.run();

    expect(s.missingRequired).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /REQUIRED_WORKSPACES is EMPTY/i,
    );
  });

  it('warns when a required pair names an actor that is not allow-listed (the row would be inert)', async () => {
    process.env[ENV_ACTORS] = 'meeting-ops';
    process.env[ENV_REQUIRED] = 'customer-ops:magic-unicorn';
    const check = makeCheck([{ userKey: 'federation:customer-ops', workspaceId: WS_MU }]);
    const warn = jest.spyOn((check as any).logger, 'warn').mockImplementation(() => undefined);

    await check.run();

    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /NOT in EMAIL_OPS_FEDERATION_ACTORS/,
    );
  });

  it('flags a required workspace that does not exist in this deployment', async () => {
    process.env[ENV_ACTORS] = 'customer-ops';
    process.env[ENV_REQUIRED] = 'customer-ops:no-such-workspace';
    const check = makeCheck([]);

    const s = await check.run();

    expect(s.missingRequired).toHaveLength(1);
    expect(s.missingRequired[0].detail).toMatch(/does not exist in this deployment/);
  });

  it('accepts a required workspace given by UUID as well as by slug', async () => {
    process.env[ENV_ACTORS] = 'customer-ops';
    process.env[ENV_REQUIRED] = `customer-ops:${WS_MU}`;
    const check = makeCheck([{ userKey: 'federation:customer-ops', workspaceId: WS_MU }]);

    expect((await check.run()).missingRequired).toEqual([]);
  });

  it('no allow-listed actors ⇒ nothing to assert, and no DB read', async () => {
    process.env[ENV_ACTORS] = '';
    process.env[ENV_REQUIRED] = '';
    const check = makeCheck([]);

    const s = await check.run();

    expect(s.actors).toEqual([]);
    expect(s.missingRequired).toEqual([]);
    expect((check as any).prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  it('DOES NOT THROW when the DB is unavailable at boot — records UNKNOWN instead', async () => {
    process.env[ENV_ACTORS] = 'customer-ops';
    process.env[ENV_REQUIRED] = 'customer-ops:magic-unicorn';
    const check = makeCheck([]);
    (check as any).prisma.workspace.findMany = jest.fn().mockRejectedValue(new Error('db down'));
    jest.spyOn((check as any).logger, 'error').mockImplementation(() => undefined);

    // Booting must not be blocked by this check — a degraded read surface is bad,
    // a refusal to start is worse.
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(check.getStatus().error).toBe('db down');
  });

  it('exposes "not yet checked" before bootstrap so health can say UNKNOWN', () => {
    const check = makeCheck([]);
    expect(check.getStatus().checked).toBe(false);
  });
});
