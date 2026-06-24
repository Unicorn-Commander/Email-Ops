import { NotFoundException } from '@nestjs/common';
import { MessageDisposition, SenderPolicyKind, SenderPolicyScope, User } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { DispositionService } from './disposition.service';
import { SenderPolicyService } from './sender-policy.service';
import { MailTriageController } from './mail-triage.controller';

/**
 * MailTriageController: prove it delegates with the resolved workspace + acting
 * sub, and that the "mark spam + block the sender" combo fires BOTH services in
 * one call.
 */
describe('MailTriageController (delegation)', () => {
  const WS = '0190a000-7e57-7000-8000-0000000000f1';

  function user(): User {
    const u: WithWorkspaceClaim = {
      id: 'local-1',
      email: 'aaron@magicunicorn.tech',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      keycloakId: 'kc-aaron',
      kcRefreshTokenEnc: null,
      kcRefreshUpdatedAt: null,
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      __ucUid: 'kc-aaron',
      __entitlements: [],
      __workspaceClaim: WS,
    };
    return u as User;
  }

  function make(
    disposition: Partial<jest.Mocked<DispositionService>>,
    senderPolicy: Partial<jest.Mocked<SenderPolicyService>>,
  ) {
    return new MailTriageController(
      disposition as unknown as DispositionService,
      senderPolicy as unknown as SenderPolicyService,
    );
  }

  it('PUT disposition delegates to setDisposition with the resolved workspace + sub', async () => {
    const setDisposition = jest.fn().mockResolvedValue({ thread_id: 't1', disposition: 'ARCHIVE' });
    const out = await make({ setDisposition }, {}).setDisposition(WS, user(), 't1', {
      disposition: MessageDisposition.ARCHIVE,
    } as never);
    expect(setDisposition).toHaveBeenCalledWith(WS, 'kc-aaron', 't1', MessageDisposition.ARCHIVE);
    expect(out.sender_policy).toBeNull();
  });

  it('mark SPAM + block_sender fires BOTH the disposition and a BLOCK sender rule', async () => {
    const setDisposition = jest.fn().mockResolvedValue({ thread_id: 't1', disposition: 'SPAM' });
    const set = jest.fn().mockResolvedValue({ id: 'r1', kind: 'BLOCK' });
    const out = await make({ setDisposition }, { set }).setDisposition(WS, user(), 't1', {
      disposition: MessageDisposition.SPAM,
      block_sender: true,
      sender_address: 'Spammer@Evil.com',
    } as never);
    expect(set).toHaveBeenCalledWith(
      WS,
      'kc-aaron',
      expect.objectContaining({
        scope: SenderPolicyScope.ADDRESS,
        pattern: 'Spammer@Evil.com',
        kind: SenderPolicyKind.BLOCK,
      }),
    );
    expect(out.sender_policy).toEqual({ id: 'r1', kind: 'BLOCK' });
  });

  it('does NOT touch sender policy when no sender_address is given', async () => {
    const setDisposition = jest.fn().mockResolvedValue({ thread_id: 't1', disposition: 'TRASH' });
    const set = jest.fn();
    await make({ setDisposition }, { set }).setDisposition(WS, user(), 't1', {
      disposition: MessageDisposition.TRASH,
      block_sender: true, // no sender_address → no-op
    } as never);
    expect(set).not.toHaveBeenCalled();
  });

  it('GET sender-policies wraps items + count; DELETE maps a miss to 404', async () => {
    const list = jest.fn().mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    const wrapped = await make({}, { list }).listSenderPolicies(WS, user());
    expect(wrapped).toEqual({ items: [{ id: 'r1' }, { id: 'r2' }], count: 2 });

    const remove = jest.fn().mockResolvedValue(false);
    await expect(make({}, { remove }).removeSenderPolicy(WS, user(), 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
