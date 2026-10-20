import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentInboxKind, AgentInboxState, User } from '@prisma/client';
import { MembershipService } from '../common/workspace/membership.service';
import { EmailService } from '../email/email.service';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { AgentInboxController } from './agent-inbox.controller';

/**
 * Agent-inbox REST controller tests: prove the controller DELEGATES to the
 * EXISTING EmailService approval methods with the resolved workspace + acting
 * user, and re-derives the entitlement gate on approve BY ITEM KIND (peeked
 * first): EMAIL is the human-in-the-loop SEND → dual-SKU compose gate; CLEANUP
 * merely runs a cleaner batch → cleaner (email-ops) SKU only. The service is
 * mocked — the delegation contract is what's under test, not the (separately
 * tested) approval logic itself.
 */
describe('AgentInboxController (delegation)', () => {
  const WS = '0190a000-7e57-7000-8000-00000000e001';

  // A verified user carrying the entitlements the per-kind gates read.
  function userWith(entitlements: string[]): User {
    const u: WithWorkspaceClaim = {
      id: 'local-user-1',
      email: 'aaron@magicunicorn.tech',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      picture: null,
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
    return new AgentInboxController(
      mock as unknown as EmailService,
      { assertCanReviewInbox: jest.fn().mockResolvedValue(WS) } as unknown as MembershipService,
    );
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
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.EMAIL);
    const approveAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { state: 'approved' }, message: { status: 'sent' } });
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });
    const out = await ctrl.approve(WS, userWith(bothSkus), 'item-9', { note: 'lgtm' });

    expect(peekAgentInboxKind).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'item-9');
    expect(approveAgentInboxItem).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      'item-9',
      'lgtm',
      undefined,
    );
    expect(out).toMatchObject({ inbox: { state: 'approved' }, message: { status: 'sent' } });
  });

  it('POST approve passes trustRecipients:false through (Wave 7 learning opt-out)', async () => {
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.EMAIL);
    const approveAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { state: 'approved' }, message: { status: 'sent' } });
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });
    await ctrl.approve(WS, userWith(bothSkus), 'item-9', { note: 'ok', trustRecipients: false });
    expect(approveAgentInboxItem).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'item-9', 'ok', false);
  });

  it('GET auto-sent delegates to listAutoSentFeed and returns { items } (Wave 7 pinned shape)', async () => {
    const listAutoSentFeed = jest
      .fn()
      .mockResolvedValue([
        { id: 'ev1', agentKey: 'bot', createdAt: 'now', detail: 'd', message: null },
      ]);
    const ctrl = make({ listAutoSentFeed });
    const out = await ctrl.autoSent(WS, userWith(bothSkus), '25');
    expect(listAutoSentFeed).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 25);
    expect(out).toEqual({
      items: [{ id: 'ev1', agentKey: 'bot', createdAt: 'now', detail: 'd', message: null }],
    });
  });

  it('GET :id delegates to getAgentInboxItemDetail; unknown/foreign id 404s (Wave 7 detail read)', async () => {
    const getAgentInboxItemDetail = jest
      .fn()
      .mockResolvedValue({ id: 'item-1', state: 'pending', message: { id: 'm1' } });
    const ctrl = make({ getAgentInboxItemDetail });
    const out = await ctrl.detail(WS, userWith(bothSkus), 'item-1');
    expect(getAgentInboxItemDetail).toHaveBeenCalledWith(WS, 'kc-sub-aaron', 'item-1');
    expect(out).toEqual({ item: { id: 'item-1', state: 'pending', message: { id: 'm1' } } });

    const miss = make({ getAgentInboxItemDetail: jest.fn().mockResolvedValue(null) });
    await expect(miss.detail(WS, userWith(bothSkus), 'foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('POST approve of an EMAIL item is ALLOWED for an email-ops-only caller (own-mailbox send)', async () => {
    // A human approving a queued draft in Email-Ops is sending THEIR OWN mail
    // from THEIR OWN mailbox. The dual-SKU rule exists for the CROSS-APP trigger
    // (Customer-Ops reaching through the federation seam) and is applied where
    // that call declares its external_source. Demanding customer-ops here made a
    // standalone Email-Ops customer unable to send at all.
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.EMAIL);
    const approveAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { state: 'approved' }, message: null });
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });

    const out = await ctrl.approve(WS, userWith(['email-ops']), 'item-9', {});

    expect(approveAgentInboxItem).toHaveBeenCalled();
    expect(out).toMatchObject({ inbox: { state: 'approved' } });
  });

  it('POST approve of an EMAIL item is BLOCKED (403) for a caller with NO email-ops SKU', async () => {
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.EMAIL);
    const approveAgentInboxItem = jest.fn();
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });
    await expect(ctrl.approve(WS, userWith(['customer-ops']), 'item-9', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // The send delegate is never reached when the gate denies.
    expect(approveAgentInboxItem).not.toHaveBeenCalled();
  });

  it('POST approve of a CLEANUP item is ALLOWED for a cleaner-only caller (cleaner SKU, not the dual)', async () => {
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.CLEANUP);
    const approveAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { state: 'approved' }, message: null });
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });
    // email-ops alone satisfies checkCleanerEntitlement — the bug this guards
    // against was routing a CLEANUP approval through the dual-SKU compose gate.
    const out = await ctrl.approve(WS, userWith(['email-ops']), 'item-c1', { note: 'run it' });

    expect(approveAgentInboxItem).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      'item-c1',
      'run it',
      undefined,
    );
    expect(out).toMatchObject({ inbox: { state: 'approved' } });
  });

  it('POST approve of a CLEANUP item is ALLOWED for a dual-SKU caller too', async () => {
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.CLEANUP);
    const approveAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { state: 'approved' }, message: null });
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });
    await ctrl.approve(WS, userWith(bothSkus), 'item-c2', {});
    expect(approveAgentInboxItem).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      'item-c2',
      null,
      undefined,
    );
  });

  it('POST approve of a NOTICE item needs no send entitlement', async () => {
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.NOTICE);
    const approveAgentInboxItem = jest
      .fn()
      .mockResolvedValue({ inbox: { kind: 'NOTICE', state: 'approved' }, message: null });
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });

    const out = await ctrl.approve(WS, userWith([]), 'item-n1', { note: 'acknowledged' });

    expect(approveAgentInboxItem).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      'item-n1',
      'acknowledged',
      undefined,
    );
    expect(out).toMatchObject({ inbox: { kind: 'NOTICE', state: 'approved' }, message: null });
  });

  it('POST approve of an unknown id is 404 from the kind peek — never an entitlement error', async () => {
    const peekAgentInboxKind = jest.fn().mockResolvedValue(null);
    const approveAgentInboxItem = jest.fn();
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });
    // Even a caller with NO SKUs gets the 404, not a 403: the peek runs first.
    await expect(ctrl.approve(WS, userWith([]), 'nope', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(approveAgentInboxItem).not.toHaveBeenCalled();
  });

  it('POST approve maps a vanished item (peek hit, approve missed) to 404', async () => {
    const peekAgentInboxKind = jest.fn().mockResolvedValue(AgentInboxKind.EMAIL);
    const approveAgentInboxItem = jest.fn().mockResolvedValue(null);
    const ctrl = make({ peekAgentInboxKind, approveAgentInboxItem });
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

  it('POST send-kit proposal delegates the full proposal after the compose entitlement check', async () => {
    const proposeSendKit = jest.fn().mockResolvedValue({ kit_id: 'kit-1', state: 'PROPOSED' });
    const ctrl = make({ proposeSendKit });
    const out = await ctrl.proposeSendKit(WS, userWith(['email-ops']), {
      kit_id: 'kit-1',
      title: 'Secure links',
      body_template: '{first_name},\n\nLink: {token}',
      subjects: ['Your link'],
      recipients: ['ALICE@example.com'],
      from_address: 'outreach@example.org',
      cap_per_day: 2,
      expires_at: '2026-10-01T00:00:00.000Z',
    });

    expect(proposeSendKit).toHaveBeenCalledWith(
      WS,
      'kc-sub-aaron',
      expect.objectContaining({
        kitId: 'kit-1',
        title: 'Secure links',
        expiresAt: expect.any(Date),
      }),
    );
    expect(out).toMatchObject({ state: 'PROPOSED' });
  });

  it('PAT and federation identities cannot approve or reject send kits', async () => {
    const pat = userWith(bothSkus) as any;
    pat.__patAuth = { id: 'pat-1' };
    const ctrl = make({ approveSendKit: jest.fn(), rejectSendKit: jest.fn() });

    await expect(
      ctrl.approveSendKitProposal(WS, pat, 'kit-1', { template_sha256: 'a'.repeat(64) }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.rejectSendKit(WS, pat, 'kit-1', { note: 'no' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('GET send-kits returns the list and human-session signal', async () => {
    const listSendKits = jest.fn().mockResolvedValue([{ kit_id: 'kit-1', state: 'PROPOSED' }]);
    const ctrl = make({ listSendKits });
    const out = await ctrl.listSendKits(WS, userWith(bothSkus), {});

    expect(listSendKits).toHaveBeenCalledWith(WS, 'kc-sub-aaron', undefined);
    expect(out).toEqual({
      items: [{ kit_id: 'kit-1', state: 'PROPOSED' }],
      count: 1,
      human_session: true,
    });
  });
});
