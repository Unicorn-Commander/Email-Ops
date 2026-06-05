import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentInboxState, User } from '@prisma/client';
import { EmailService } from '../email/email.service';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { AgentInboxController } from './agent-inbox.controller';

/**
 * Agent-inbox REST controller tests: prove the controller DELEGATES to the
 * EXISTING EmailService approval methods with the resolved workspace + acting
 * user, and re-derives the dual-SKU compose gate on approve (the human-in-the-
 * loop SEND). The service is mocked — the delegation contract is what's under
 * test, not the (separately tested) approval logic itself.
 */
describe('AgentInboxController (delegation)', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';

  // A verified user carrying the entitlements the compose gate reads.
  function userWith(entitlements: string[]): User {
    const u: WithWorkspaceClaim = {
      id: 'local-user-1',
      email: 'aaron@magicunicorn.tech',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      keycloakId: 'kc-sub-aaron',
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __ucUid: 'kc-sub-aaron',
      __entitlements: entitlements,
      __workspaceClaim: WS,
    };
    return u as User;
  }

  const bothSkus = ['customer-ops', 'email-ops'];

  // Build a controller over a mocked EmailService.
  function make(mock: Partial<jest.Mocked<EmailService>>) {
    return new AgentInboxController(mock as unknown as EmailService);
  }

  // Force enforce-mode so the entitlement gate is real (not open-bootstrap).
  const savedEnv = process.env.UC_ENTITLEMENT_MODE;
  beforeAll(() => {
    process.env.UC_ENTITLEMENT_MODE = 'enforce';
  });
  afterAll(() => {
    process.env.UC_ENTITLEMENT_MODE = savedEnv;
  });

  it('GET list delegates to listAgentInbox with the resolved workspace, acting sub, and state filter', async () => {
    const listAgentInbox = jest.fn().mockResolvedValue([{ id: 'i1', state: 'approved' }]);
    const ctrl = make({ listAgentInbox });
    const out = await ctrl.list(WS, userWith(bothSkus), { state: 'approved' });

    expect(listAgentInbox).toHaveBeenCalledWith(WS, 'kc-sub-aaron', AgentInboxState.APPROVED);
    expect(out).toEqual({ items: [{ id: 'i1', state: 'approved' }], count: 1 });
  });

  it('GET list with no state passes undefined (service defaults to PENDING)', async () => {
    const listAgentInbox = jest.fn().mockResolvedValue([]);
    const ctrl = make({ listAgentInbox });
    await ctrl.list(WS, userWith(bothSkus), {});
    expect(listAgentInbox).toHaveBeenCalledWith(WS, 'kc-sub-aaron', undefined);
  });

  it('POST approve delegates to approveAgentInboxItem and returns the result', async () => {
    const approveAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { state: 'approved' }, message: { status: 'sent' } });
    const ctrl = make({ approveAgentInboxItem });
    const out = await ctrl.approve(WS, userWith(bothSkus), 'item-9', { note: 'lgtm' });

    expect(approveAgentInboxItem).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'item-9', 'lgtm');
    expect(out).toMatchObject({ inbox: { state: 'approved' }, message: { status: 'sent' } });
  });

  it('POST approve is BLOCKED (403) without the dual customer-ops+email-ops SKU (gate re-derived)', async () => {
    const approveAgentInboxItem = jest.fn();
    const ctrl = make({ approveAgentInboxItem });
    await expect(
      ctrl.approve(WS, userWith(['email-ops']), 'item-9', {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // The send delegate is never reached when the gate denies.
    expect(approveAgentInboxItem).not.toHaveBeenCalled();
  });

  it('POST approve maps a missing item to 404', async () => {
    const approveAgentInboxItem = jest.fn().mockResolvedValue(null);
    const ctrl = make({ approveAgentInboxItem });
    await expect(ctrl.approve(WS, userWith(bothSkus), 'nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('POST reject delegates to rejectAgentInboxItem (no SKU gate — a reject never sends)', async () => {
    const rejectAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { state: 'rejected' }, message: { status: 'rejected' } });
    const ctrl = make({ rejectAgentInboxItem });
    // Even a caller WITHOUT the dual SKU may reject (it's a decline, not a send).
    const out = await ctrl.reject(WS, userWith(['email-ops']), 'item-3', { note: 'off-message' });

    expect(rejectAgentInboxItem).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'item-3', 'off-message');
    expect(out).toMatchObject({ inbox: { state: 'rejected' } });
  });

  it('POST reject maps a missing item to 404', async () => {
    const rejectAgentInboxItem = jest.fn().mockResolvedValue(null);
    const ctrl = make({ rejectAgentInboxItem });
    await expect(ctrl.reject(WS, userWith(bothSkus), 'nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
