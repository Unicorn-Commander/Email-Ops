import { PrismaService } from '../prisma/prisma.service';
import { TwilioPort } from '../twilio/twilio.port';
import { TwilioSendRequest, TwilioSendResult } from '../twilio/twilio.types';
import { SmsService } from './sms.service';

class FakeTwilio extends TwilioPort {
  isConfigured(): boolean {
    return true;
  }
  async send(_req: TwilioSendRequest): Promise<TwilioSendResult> {
    return { accepted: true, providerMessageId: 'SM-test', lane: 'twilio' };
  }
}

describe('SmsService inbound resolver', () => {
  it('resolves the inbound line through the BYPASSRLS system client before the scoped write', async () => {
    const workspaceId = 'ws-sms-system';
    const line = '+15550009999';
    const tx = {
      smsMessage: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'sms-system-resolved' }),
      },
    };
    const systemClient = {
      smsAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: 'sms-acct-system', workspaceId }),
      },
    };
    const runtimeSmsAccount = {
      findFirst: jest.fn(async () => {
        throw new Error('runtime client must not resolve workspace-agnostic SMS webhooks');
      }),
    };
    const prisma = {
      systemClient,
      smsAccount: runtimeSmsAccount,
      withWorkspace: jest.fn((_workspaceId: string, _ucUid: string | null, fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const service = new SmsService(prisma, new FakeTwilio());

    const res = await service.recordInboundSms({
      provider: 'twilio',
      providerMessageId: 'SM-system',
      fromPhoneNumber: '+15551112222',
      toPhoneNumber: line,
      body: 'inbound through system resolver',
    });

    expect(res).toMatchObject({ outcome: 'recorded', workspaceId, smsMessageId: 'sms-system-resolved' });
    expect(systemClient.smsAccount.findFirst).toHaveBeenCalledWith({
      where: { phoneNumber: line, active: true },
      select: { id: true, workspaceId: true },
    });
    expect(runtimeSmsAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.withWorkspace).toHaveBeenCalledWith(workspaceId, null, expect.any(Function));
  });
});
