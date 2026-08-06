import { TwilioSendRequest, TwilioSendResult } from './twilio.types';

/**
 * The SMS engine seam (the enterprise/shared-line channel). The DI token the SMS
 * send path injects — the abstract analogue of StalwartPort for email. The
 * concrete TwilioClient is degrade-clean (dormant without TWILIO_* env); a unit
 * test substitutes a fake TwilioPort with no live provider.
 *
 * Deliberately narrow: SMS is 1:1 and has no server-side threading to read, so
 * there is no listThreads/listMessages — outbound `send` plus an inbound webhook
 * (recorded by SmsService) are the whole surface. When the in-house SMS engine
 * lands, it implements this same port and the send path does not change.
 */
export abstract class TwilioPort {
  abstract isConfigured(): boolean;

  abstract send(request: TwilioSendRequest): Promise<TwilioSendResult>;
}
