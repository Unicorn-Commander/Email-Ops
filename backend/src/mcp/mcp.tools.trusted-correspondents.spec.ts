import { BadRequestException } from '@nestjs/common';
import { User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { TrustedCorrespondentsService } from '../trusted-correspondents/trusted-correspondents.service';
import { TrustedCorrespondentTools } from './mcp.tools';

/**
 * Wave 7 — TrustedCorrespondentTools dispatch: the MCP twin of the trusted-
 * correspondents REST routes. Pins the seam only — workspace resolution via the
 * membership gate, pass-through into the SAME service the REST controller uses,
 * the standard ok:false miss shape, and that service validation errors surface.
 */
describe('TrustedCorrespondentTools', () => {
  const user = { id: 'u1', email: 'user@example.test', __ucUid: 'uc-user-1' } as unknown as User;

  const ROW = {
    id: 'tc-1',
    address: 'jane@ext.test',
    scope: 'ADDRESS',
    source: 'MANUAL',
    approvalCount: 2,
    lastApprovedAt: '2026-07-19T00:00:00.000Z',
    addedByUcUid: 'uc-user-1',
    note: null,
    createdAt: '2026-07-18T00:00:00.000Z',
  };

  const membership = { resolveAndAuthorize: jest.fn() } as unknown as MembershipService;
  const trusted = {
    list: jest.fn(),
    add: jest.fn(),
    removeByAddress: jest.fn(),
  } as unknown as TrustedCorrespondentsService;

  beforeEach(() => {
    jest.clearAllMocks();
    (membership.resolveAndAuthorize as jest.Mock).mockResolvedValue('ws-1');
  });

  const tools = () => new TrustedCorrespondentTools(membership, trusted);

  it('list_trusted_correspondents → { items, count } through the resolved workspace', async () => {
    (trusted.list as jest.Mock).mockResolvedValue([ROW]);
    await expect(
      tools().listTrustedCorrespondents(user, { workspace_id: 'ws-1' }),
    ).resolves.toEqual({ items: [ROW], count: 1 });
    expect(membership.resolveAndAuthorize).toHaveBeenCalledWith(user, 'ws-1');
    expect(trusted.list).toHaveBeenCalledWith('ws-1', 'uc-user-1');
  });

  it('trust_correspondent passes address + note + scope into the service (the validator)', async () => {
    (trusted.add as jest.Mock).mockResolvedValue(ROW);
    await expect(
      tools().trustCorrespondent(user, { address: 'jane@ext.test', note: 'partner' }),
    ).resolves.toEqual(ROW);
    expect(trusted.add).toHaveBeenCalledWith('ws-1', 'uc-user-1', {
      address: 'jane@ext.test',
      note: 'partner',
      scope: null,
    });
  });

  it('trust_correspondent forwards an explicit domain scope (Wave 10)', async () => {
    (trusted.add as jest.Mock).mockResolvedValue({ ...ROW, address: 'acme.com', scope: 'DOMAIN' });
    await tools().trustCorrespondent(user, { address: 'acme.com', scope: 'domain' });
    expect(trusted.add).toHaveBeenCalledWith('ws-1', 'uc-user-1', {
      address: 'acme.com',
      note: null,
      scope: 'domain',
    });
  });

  it('trust_correspondent surfaces the service validation error (never swallowed)', async () => {
    (trusted.add as jest.Mock).mockRejectedValue(new BadRequestException('A valid email address is required.'));
    await expect(tools().trustCorrespondent(user, { address: 'junk' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('untrust_correspondent → { ok:true } on delete; the standard miss shape otherwise', async () => {
    (trusted.removeByAddress as jest.Mock).mockResolvedValue(true);
    await expect(tools().untrustCorrespondent(user, { address: 'jane@ext.test' })).resolves.toEqual({
      ok: true,
    });
    expect(trusted.removeByAddress).toHaveBeenCalledWith('ws-1', 'uc-user-1', 'jane@ext.test');

    (trusted.removeByAddress as jest.Mock).mockResolvedValue(false);
    await expect(tools().untrustCorrespondent(user, { address: 'ghost@ext.test' })).resolves.toEqual({
      ok: false,
      reason: 'address is not a trusted correspondent in this workspace',
    });
  });
});
