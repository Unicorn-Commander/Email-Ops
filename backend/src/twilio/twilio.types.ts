/**
 * The SMS engine wire types. Channel-analogous to stalwart.types — the SMS send
 * request/result the Comms send path hands to the provider seam.
 */

export interface TwilioSendRequest {
  fromPhoneNumber: string;
  toPhoneNumber: string;
  body: string;
}

export interface TwilioSendResult {
  accepted: boolean;
  /** The provider's message id (Twilio MessageSid) once accepted; null otherwise. */
  providerMessageId: string | null;
  lane: 'twilio' | null;
  reason?: string | null;
}
