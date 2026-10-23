import { NotFoundException } from '@nestjs/common';
import { MessageDisposition, SenderPolicyKind, SenderPolicyScope, User } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { SenderPolicyService } from './sender-policy.service';
import { EmailService } from '../email/email.service';
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
      picture: null,
      keycloakId: 'kc-aaron',
      passwordHash: null,
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

  // The controller now reconciles the REAL James mailbox via
  // EmailService.applyThreadDisposition (move + overlay) instead of an
  // overlay-only DispositionService.setDisposition.
  function make(
    email: Partial<jest.Mocked<EmailService>>,
    senderPolicy: Partial<jest.Mocked<SenderPolicyService>>,
  ) {
    return new MailTriageController(
      senderPolicy as unknown as SenderPolicyService,
      email as unknown as EmailService,
    );
  }

  it('PUT disposition delegates to applyThreadDisposition (real move + overlay) with the resolved workspace + sub', async () => {
    const applyThreadDisposition = jest
      .fn()
      .mockResolvedValue({ thread_id: 't1', disposition: 'ARCHIVE', moved: true });
    const out = await make({ applyThreadDisposition }, {}).setDisposition(WS, user(), 't1', {
      disposition: MessageDisposition.ARCHIVE,
    } as never);
    expect(applyThreadDisposition).toHaveBeenCalledWith(WS, 'kc-aaron', 't1', MessageDisposition.ARCHIVE);
    expect(out.sender_policy).toBeNull();
  });

  it('mark SPAM + block_sender fires BOTH the disposition and a BLOCK sender rule', async () => {
    const applyThreadDisposition = jest
      .fn()
      .mockResolvedValue({ thread_id: 't1', disposition: 'SPAM', moved: true });
    const set = jest.fn().mockResolvedValue({ id: 'r1', kind: 'BLOCK' });
    const out = await make({ applyThreadDisposition }, { set }).setDisposition(WS, user(), 't1', {
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
    const applyThreadDisposition = jest
      .fn()
      .mockResolvedValue({ thread_id: 't1', disposition: 'TRASH', moved: false });
    const set = jest.fn();
    await make({ applyThreadDisposition }, { set }).setDisposition(WS, user(), 't1', {
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
