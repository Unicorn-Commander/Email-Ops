import { AgentAutonomyLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TwilioPort } from '../twilio/twilio.port';
import { TwilioSendRequest, TwilioSendResult } from '../twilio/twilio.types';
import { SmsService } from './sms.service';

/**
 * SmsService against the REAL verify DB (emailops) so the withWorkspace RLS path
 * + Prisma writes are exercised for real, with the SMS engine MOCKED (a fake
 * TwilioPort — no live provider). Pins that an SMS send reuses the EXACT email
 * governance: idempotency, kill switch, the autonomy dial, the agent-inbox
 * approval flow, the audit log; plus the inbound record path.
 *
 * Same verify DB the email specs use (postgresql://postgres:REMOVED@…:55444/emailops);
 * tests connect as the owner (RLS inert under FORCE+BYPASS for owner) — the
 * separate prisma/rls-acceptance.sql proves the fence under email_ops_app.
 */
const DB_URL = 'postgresql://postgres:REMOVED@127.0.0.1:55444/emailops?schema=public';

class FakeTwilio extends TwilioPort {
  public calls: TwilioSendRequest[] = [];
  public configured = true;
  public accept = true;

  isConfigured(): boolean {
    return this.configured;
  }
  async send(req: TwilioSendRequest): Promise<TwilioSendResult> {
    this.calls.push(req);
    if (!this.accept) {
      return { accepted: false, providerMessageId: null, lane: 'twilio', reason: 'rejected' };
    }
    return { accepted: true, providerMessageId: `SM-${this.calls.length}`, lane: 'twilio' };
  }
}

describe('SmsService (verify DB; Twilio MOCKED)', () => {
  let prisma: PrismaService;
  let twilio: FakeTwilio;
  let service: SmsService;

  const WS = `0190a000-7e57-7000-8000-1111${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;
  const UC_UID = 'uc-uid-sms-test';
  const LINE = '+15550009999'; // the workspace's own SMS line

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.workspace.upsert({
      where: { id: WS },
      update: {},
      create: { id: WS, slug: `ws-${WS.slice(-6)}`, displayName: 'SMS test ws' },
    });
    await prisma.smsAccount.create({
      data: { workspaceId: WS, phoneNumber: LINE, displayName: 'Test line', isDefault: true },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.agentInboxItem.deleteMany({ where: { workspaceId: WS } });
      await prisma.agentActionEvent.deleteMany({ where: { workspaceId: WS } });
      await prisma.agent.deleteMany({ where: { workspaceId: WS } });
      await prisma.smsMessage.deleteMany({ where: { workspaceId: WS } });
      await prisma.smsAccount.deleteMany({ where: { workspaceId: WS } });
      await prisma.workspace.deleteMany({ where: { id: WS } });
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    twilio = new FakeTwilio();
    service = new SmsService(prisma, twilio);
    // a clean agent slate per test
    await prisma.agent.deleteMany({ where: { workspaceId: WS } });
  });

  async function makeAgent(key: string, level: AgentAutonomyLevel) {
    await prisma.agent.create({
      data: { workspaceId: WS, key, displayName: key, autonomyLevel: level },
    });
  }

  describe('compose — send', () => {
    it('records the SoR row + hands to Twilio (status sent, from the line)', async () => {
      const ref = `send-${Date.now()}`;
      const r = await service.composeSms(WS, UC_UID, {
        contactId: 'c-1',
        toPhoneNumber: '+15551112222',
        body: 'Hi from the desk',
        mode: 'send',
        externalSource: 'customer-ops',
        externalRef: ref,
      });
      expect(r).toMatchObject({ channel: 'sms', status: 'sent', mode: 'send', to: '+15551112222', external_ref: ref });
      expect(twilio.calls).toHaveLength(1);
      expect(twilio.calls[0]).toMatchObject({ fromPhoneNumber: LINE, toPhoneNumber: '+15551112222', body: 'Hi from the desk' });
      const row = await prisma.smsMessage.findUnique({ where: { id: r.id } });
      expect(row?.status).toBe('SENT');
      expect(row?.providerMessageId).toBe('SM-1');
    });

    it('records FAILED (never throws) when Twilio rejects (degrade-clean)', async () => {
      twilio.accept = false;
      const r = await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15553334444',
        body: 'x',
        mode: 'send',
        externalSource: 'customer-ops',
        externalRef: `fail-${Date.now()}`,
      });
      expect(r.status).toBe('failed');
      const row = await prisma.smsMessage.findUnique({ where: { id: r.id } });
      expect(row?.status).toBe('FAILED');
    });

    it('is IDEMPOTENT on (workspace, source, ref): a repeat returns the existing row, sends once', async () => {
      const ref = `idem-${Date.now()}`;
      const first = await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15555556666', body: 'once', mode: 'send', externalSource: 'customer-ops', externalRef: ref,
      });
      const second = await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15555556666', body: 'once', mode: 'send', externalSource: 'customer-ops', externalRef: ref,
      });
      expect(second.id).toBe(first.id);
      expect(twilio.calls).toHaveLength(1); // not two
    });
  });

  describe('governance — kill switch + per-agent pause', () => {
    it('the workspace kill switch (agentsPaused) blocks compose', async () => {
      await prisma.workspace.update({ where: { id: WS }, data: { agentsPaused: true } });
      try {
        await expect(
          service.composeSms(WS, UC_UID, {
            toPhoneNumber: '+1', body: 'x', mode: 'send', externalSource: 'customer-ops', externalRef: `ks-${Date.now()}`,
          }),
        ).rejects.toThrow(/paused/i);
      } finally {
        await prisma.workspace.update({ where: { id: WS }, data: { agentsPaused: false } });
      }
    });

    it('a paused agent is blocked', async () => {
      await prisma.agent.create({
        data: { workspaceId: WS, key: 'paused-bot', displayName: 'Paused', autonomyLevel: AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, paused: true },
      });
      await expect(
        service.composeSms(WS, UC_UID, {
          toPhoneNumber: '+1', body: 'x', mode: 'send', externalSource: 'paused-bot', externalRef: `pa-${Date.now()}`, draftedBy: 'paused-bot',
        }),
      ).rejects.toThrow(/paused/i);
    });
  });

  describe('the autonomy dial (shared with email)', () => {
    it('an L1 agent send is COERCED to a draft (staged, not sent) + audited', async () => {
      await makeAgent('l1-bot', AgentAutonomyLevel.L1_APPROVE_TO_SEND);
      const r = await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15557778888', body: 'needs approval', mode: 'send',
        externalSource: 'l1-bot', externalRef: `l1-${Date.now()}`, draftedBy: 'l1-bot',
      });
      expect(r.mode).toBe('draft');
      expect(twilio.calls).toHaveLength(0); // NOT sent
      const row = await prisma.smsMessage.findUnique({ where: { id: r.id } });
      expect(row?.status).toBe('PENDING_APPROVAL');
      const inbox = await prisma.agentInboxItem.findFirst({ where: { smsMessageId: r.id } });
      expect(inbox?.state).toBe('PENDING');
      const audit = await prisma.agentActionEvent.findFirst({ where: { workspaceId: WS, messageId: r.id, kind: 'STAGED_FOR_APPROVAL' } });
      expect(audit).toBeTruthy();
    });

    it('an L2 agent sends autonomously + records an AUTONOMOUS_SEND audit', async () => {
      await makeAgent('l2-bot', AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT);
      const r = await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15559990000', body: 'auto', mode: 'send',
        externalSource: 'l2-bot', externalRef: `l2-${Date.now()}`, draftedBy: 'l2-bot',
      });
      expect(r.mode).toBe('send');
      expect(r.status).toBe('sent');
      expect(twilio.calls).toHaveLength(1);
      const audit = await prisma.agentActionEvent.findFirst({ where: { workspaceId: WS, messageId: r.id, kind: 'AUTONOMOUS_SEND' } });
      expect(audit).toBeTruthy();
    });
  });

  describe('the agent-inbox (SMS drafts)', () => {
    it('approve sends the staged draft (PENDING → APPROVED, sms → sent)', async () => {
      const r = await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15551230000', body: 'draft me', mode: 'draft',
        externalSource: 'customer-ops', externalRef: `appr-${Date.now()}`,
      });
      const item = await prisma.agentInboxItem.findFirst({ where: { smsMessageId: r.id } });
      expect(item).toBeTruthy();
      const out = await service.approveSmsInboxItem(WS, UC_UID, item!.id);
      expect(out?.inbox.state).toBe('approved');
      expect(twilio.calls).toHaveLength(1);
      const row = await prisma.smsMessage.findUnique({ where: { id: r.id } });
      expect(row?.status).toBe('SENT');
    });

    it('reject marks it rejected and never sends', async () => {
      const r = await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15551230001', body: 'no', mode: 'draft',
        externalSource: 'customer-ops', externalRef: `rej-${Date.now()}`,
      });
      const item = await prisma.agentInboxItem.findFirst({ where: { smsMessageId: r.id } });
      const out = await service.rejectSmsInboxItem(WS, UC_UID, item!.id, 'not now');
      expect(out?.state).toBe('rejected');
      expect(twilio.calls).toHaveLength(0);
      const row = await prisma.smsMessage.findUnique({ where: { id: r.id } });
      expect(row?.status).toBe('REJECTED');
    });

    it('listSmsInbox returns only SMS items (pending), newest first', async () => {
      await service.composeSms(WS, UC_UID, {
        toPhoneNumber: '+15551230002', body: 'list me', mode: 'draft',
        externalSource: 'customer-ops', externalRef: `list-${Date.now()}`,
      });
      const items = await service.listSmsInbox(WS, UC_UID);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.channel === 'sms' && i.sms_message_id)).toBe(true);
    });
  });

  describe('inbound (Twilio webhook → SoR)', () => {
    it('records an inbound SMS on the workspace line (RECEIVED), idempotent on the MessageSid', async () => {
      const sid = `SMin-${Date.now()}`;
      const first = await service.recordInboundSms({
        provider: 'twilio', providerMessageId: sid, fromPhoneNumber: '+15551112222', toPhoneNumber: LINE, body: 'inbound hi',
      });
      expect(first).toMatchObject({ outcome: 'recorded', workspaceId: WS });
      const row = await prisma.smsMessage.findUnique({ where: { id: first.smsMessageId! } });
      expect(row?.direction).toBe('RECEIVED');
      expect(row?.body).toBe('inbound hi');

      // Re-delivery of the same MessageSid → duplicate (no second row).
      const again = await service.recordInboundSms({
        provider: 'twilio', providerMessageId: sid, fromPhoneNumber: '+15551112222', toPhoneNumber: LINE, body: 'inbound hi',
      });
      expect(again).toMatchObject({ outcome: 'duplicate', smsMessageId: first.smsMessageId });
    });

    it('an unknown line is unmatched (ACK, discard)', async () => {
      const res = await service.recordInboundSms({
        provider: 'twilio', providerMessageId: `x-${Date.now()}`, fromPhoneNumber: '+1', toPhoneNumber: '+19998887777', body: 'who?',
      });
      expect(res).toMatchObject({ outcome: 'unmatched', workspaceId: null });
    });
  });
});
