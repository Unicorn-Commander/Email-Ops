import { MessageDisposition } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailTriageService } from './mail-triage.service';
import { SenderPolicyService } from './sender-policy.service';
import { SpamPort, SpamVerdict } from './spam.port';

/**
 * The inbound-classify precedence, fully mocked (no DB): sender policy decides
 * first (ALLOW ⇒ INBOX/clean, BLOCK ⇒ SPAM), then the engine verdict; a dormant
 * engine changes NOTHING (honest — no fabricated score, no disposition write).
 */
function fakePrisma() {
  const tx = {
    threadDisposition: { upsert: jest.fn().mockResolvedValue({}) },
    emailMessage: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    withWorkspace: jest.fn(async (_ws: string, _uc: string | null, fn: (t: typeof tx) => unknown) =>
      fn(tx),
    ),
  } as unknown as PrismaService;
  return { prisma, tx };
}

function fakeSenderPolicy(verdict: 'BLOCK' | 'ALLOW' | null): SenderPolicyService {
  return { evaluate: jest.fn().mockResolvedValue(verdict) } as unknown as SenderPolicyService;
}

function fakeSpam(configured: boolean, verdict: SpamVerdict): SpamPort {
  return {
    isConfigured: jest.fn().mockReturnValue(configured),
    classify: jest.fn().mockResolvedValue(verdict),
    reportSpam: jest.fn(),
    reportHam: jest.fn(),
  } as unknown as SpamPort;
}

const INPUT = { threadId: 't1', fromAddress: 'sender@x.test' };

describe('MailTriageService.classifyInbound (precedence)', () => {
  it('ALLOW sender → INBOX + clean, the engine is never consulted', async () => {
    const { prisma, tx } = fakePrisma();
    const spam = fakeSpam(true, { score: 9, verdict: 'spam' }); // would say spam — but ignored
    const svc = new MailTriageService(prisma, fakeSenderPolicy('ALLOW'), spam);

    const res = await svc.classifyInbound('ws', 'uc', INPUT);

    expect(res.disposition).toBe(MessageDisposition.INBOX);
    expect(res.spam_verdict).toBe('clean');
    expect(res.reason).toBe('sender_allowed');
    expect(spam.classify).not.toHaveBeenCalled();
    expect(tx.threadDisposition.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ disposition: MessageDisposition.INBOX }) }),
    );
  });

  it('BLOCK sender → SPAM, the engine is never consulted', async () => {
    const { prisma, tx } = fakePrisma();
    const spam = fakeSpam(true, { score: 0, verdict: 'clean' });
    const svc = new MailTriageService(prisma, fakeSenderPolicy('BLOCK'), spam);

    const res = await svc.classifyInbound('ws', 'uc', INPUT);

    expect(res.disposition).toBe(MessageDisposition.SPAM);
    expect(res.reason).toBe('sender_blocked');
    expect(spam.classify).not.toHaveBeenCalled();
    expect(tx.threadDisposition.upsert).toHaveBeenCalled();
  });

  it('no sender rule + engine says spam → SPAM with the engine score', async () => {
    const { prisma, tx } = fakePrisma();
    const svc = new MailTriageService(prisma, fakeSenderPolicy(null), fakeSpam(true, { score: 9.2, verdict: 'spam' }));

    const res = await svc.classifyInbound('ws', 'uc', INPUT);

    expect(res.disposition).toBe(MessageDisposition.SPAM);
    expect(res.spam_score).toBe(9.2);
    expect(res.reason).toBe('engine_verdict');
    expect(tx.emailMessage.updateMany).toHaveBeenCalled(); // score stamped on the SoR rows
  });

  it('no sender rule + DORMANT engine → stays INBOX, NOTHING written (honest)', async () => {
    const { prisma, tx } = fakePrisma();
    const svc = new MailTriageService(prisma, fakeSenderPolicy(null), fakeSpam(false, { score: null, verdict: null }));

    const res = await svc.classifyInbound('ws', 'uc', INPUT);

    expect(res.disposition).toBe(MessageDisposition.INBOX);
    expect(res.spam_score).toBeNull();
    expect(res.reason).toBe('engine_dormant');
    expect(tx.threadDisposition.upsert).not.toHaveBeenCalled();
    expect(tx.emailMessage.updateMany).not.toHaveBeenCalled();
  });

  it('no sender rule + engine says clean → INBOX, score stamped but no disposition change', async () => {
    const { prisma, tx } = fakePrisma();
    const svc = new MailTriageService(prisma, fakeSenderPolicy(null), fakeSpam(true, { score: 0.4, verdict: 'clean' }));

    const res = await svc.classifyInbound('ws', 'uc', INPUT);

    expect(res.disposition).toBe(MessageDisposition.INBOX);
    expect(res.reason).toBe('engine_clean');
    expect(tx.threadDisposition.upsert).not.toHaveBeenCalled();
    expect(tx.emailMessage.updateMany).toHaveBeenCalledTimes(1);
  });
});
