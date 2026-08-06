import { SmsService } from './sms.service';
import { TwilioWebhookController } from './twilio-webhook.controller';
import { InboundSmsResult } from './sms.types';

function controller(record: jest.Mock): TwilioWebhookController {
  const sms = { recordInboundSms: record } as unknown as SmsService;
  return new TwilioWebhookController(sms);
}

const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

describe('TwilioWebhookController', () => {
  it('maps an inbound POST to recordInboundSms and ACKs empty TwiML', async () => {
    const record = jest.fn<Promise<InboundSmsResult>, []>().mockResolvedValue({
      outcome: 'recorded',
      workspaceId: 'ws-1',
      smsMessageId: 'sms-1',
    });
    const res = await controller(record).inbound({
      MessageSid: 'SM123',
      From: '+15551112222',
      To: '+15550009999',
      Body: 'hi there',
    });
    expect(res).toBe(TWIML);
    expect(record).toHaveBeenCalledWith({
      provider: 'twilio',
      providerMessageId: 'SM123',
      fromPhoneNumber: '+15551112222',
      toPhoneNumber: '+15550009999',
      body: 'hi there',
    });
  });

  it('ACKs + discards a malformed body (missing MessageSid) WITHOUT calling the service', async () => {
    const record = jest.fn();
    const res = await controller(record).inbound({ From: '+1', To: '+2', Body: 'x' });
    expect(res).toBe(TWIML);
    expect(record).not.toHaveBeenCalled();
  });
});
