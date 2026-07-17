import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { ProvisioningPolicyService } from '../provisioning/provisioning-policy.service';
import { MailProviderPort } from '../mail-provider/mail-provider.port';
import { MailboxAccountsController } from './mailbox-accounts.controller';
import { MailboxAccountsService } from './mailbox-accounts.service';
import { MailSignaturesService } from './mail-signatures.service';
import { MailContactsService } from './mail-contacts.service';
import { MailVacationService } from './mail-vacation.service';

describe('MailboxAccountsController (device connection)', () => {
  const WS = '0190a000-7e57-7000-8000-00000000c001';

  function user(): User {
    const u: WithWorkspaceClaim = {
      id: 'local-user-1',
      email: 'aaron@example.test',
      username: 'aaron',
      firstName: 'Aaron',
      lastName: 'S',
      picture: null,
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

  function make(mailboxesMock: Partial<jest.Mocked<MailboxAccountsService>>) {
    return new MailboxAccountsController(
      mailboxesMock as unknown as MailboxAccountsService,
      {} as ProvisioningPolicyService,
      {} as MailProviderPort,
      {} as MailSignaturesService,
      {} as MailContactsService,
      {} as MailVacationService,
    );
  }

  it('GET connection delegates with the caller ucUid and returns settings', async () => {
    const getOwnConnectionSettings = jest.fn().mockResolvedValue({
      email: 'aaron@example.test',
      username: 'aaron@example.test',
      imap: { host: 'mail.example.test', port: 993, security: 'ssl' },
      smtp: { host: 'mail.example.test', port: 587, security: 'starttls' },
      jmap: { url: 'https://mail.example.test/jmap' },
      notes: [],
      manual: [],
    });

    const out = await make({ getOwnConnectionSettings }).connection(WS, user(), 'mb-1');

    expect(getOwnConnectionSettings).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1');
    expect(out.email).toBe('aaron@example.test');
  });

  it('GET connection maps a missing mailbox to 404', async () => {
    const getOwnConnectionSettings = jest.fn().mockResolvedValue(null);
    await expect(make({ getOwnConnectionSettings }).connection(WS, user(), 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('GET connection preserves owner-scope denial as 403', async () => {
    const getOwnConnectionSettings = jest.fn().mockRejectedValue(new ForbiddenException('not owner'));
    await expect(make({ getOwnConnectionSettings }).connection(WS, user(), 'mb-2')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('POST app-password reset delegates with the caller ucUid', async () => {
    const resetOwnAppPassword = jest.fn().mockResolvedValue({ password: 'abc-def' });
    const out = await make({ resetOwnAppPassword }).resetAppPassword(WS, user(), 'mb-1');
    expect(resetOwnAppPassword).toHaveBeenCalledWith(WS, 'kc-aaron', 'mb-1');
    expect(out).toEqual({ password: 'abc-def' });
  });
});
