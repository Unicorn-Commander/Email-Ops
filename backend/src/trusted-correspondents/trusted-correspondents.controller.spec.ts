import { BadRequestException, NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { TrustedCorrespondentsController } from './trusted-correspondents.controller';
import { TrustedCorrespondentsService } from './trusted-correspondents.service';

/**
 * Wave 7 — trusted-correspondents REST delegation: the controller resolves the
 * workspace + acting user and delegates to the SAME service the MCP tools use.
 * The trust semantics themselves are covered by the service/cross-tenant specs.
 */
describe('TrustedCorrespondentsController (delegation)', () => {
  const WS = '0190a000-7e57-7000-8000-00000000c001';

  const user = {
    id: 'u1',
    email: 'aaron@magicunicorn.tech',
    __ucUid: 'kc-sub-aaron',
    __workspaceClaim: WS,
  } as unknown as User & WithWorkspaceClaim;

  const ROW = {
    id: 'tc-1',
    address: 'jane@ext.test',
    source: 'MANUAL',
    approvalCount: 0,
    lastApprovedAt: null,
    addedByUcUid: 'kc-sub-aaron',
    note: null,
    createdAt: '2026-07-20T00:00:00.000Z',
  };

  function make(mock: Partial<jest.Mocked<TrustedCorrespondentsService>>) {
    return new TrustedCorrespondentsController(mock as unknown as TrustedCorrespondentsService);
  }

  it('GET list → { items } via the resolved workspace + acting sub (the pinned Wave-7 shape)', async () => {
    const list = jest.fn().mockResolvedValue([ROW]);
    const ctrl = make({ list });
    await expect(ctrl.list(WS, user)).resolves.toEqual({ items: [ROW] });
    expect(list).toHaveBeenCalledWith(WS, 'kc-sub-aaron');
  });

  it('POST add delegates { address, note } and returns the row', async () => {
    const add = jest.fn().mockResolvedValue(ROW);
    const ctrl = make({ add });
    await expect(
      ctrl.add(WS, user, { address: 'Jane <jane@ext.test>', note: 'partner' }),
    ).resolves.toEqual(ROW);
    expect(add).toHaveBeenCalledWith(WS, 'kc-sub-aaron', {
      address: 'Jane <jane@ext.test>',
      note: 'partner',
    });
  });

  it('POST add surfaces the service validation error (never swallowed)', async () => {
    const add = jest.fn().mockRejectedValue(new BadRequestException('A valid email address is required.'));
    const ctrl = make({ add });
    await expect(ctrl.add(WS, user, { address: 'junk' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DELETE removes by row id; an unknown/foreign id 404s', async () => {
    const remove = jest.fn().mockResolvedValue(true);
    const ctrl = make({ remove });
    await expect(ctrl.remove(WS, user, 'tc-1')).resolves.toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'tc-1');

    const miss = make({ remove: jest.fn().mockResolvedValue(false) });
    await expect(miss.remove(WS, user, 'foreign')).rejects.toBeInstanceOf(NotFoundException);
  });
});
