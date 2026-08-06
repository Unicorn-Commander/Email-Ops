import { AgentAutonomyLevel } from '@prisma/client';
import {
  AgentComposeContext,
  AutonomyAgent,
  decideAgentComposeMode,
  decideComposeMode,
  MAX_ROUTINE_EXTERNAL_RECIPIENTS,
  normalizeAddress,
  splitRecipients,
} from './autonomy';

/**
 * Wave 7 — the agent-send autonomy MATRIX, exhaustively (pure; no DB):
 * "first contact needs a human; ongoing conversation flows."
 *
 *   Class A (user/unknown mailbox) → draft, ALWAYS, any level.
 *   Class B (agent mailbox):
 *     L0 → draft (everything).
 *     L1 → all-internal SEND (new semantics: internal-autonomous); any external → draft.
 *     L2 → all-internal SEND; external SEND only when ROUTINE (in-thread reply
 *          to a real inbound, every external trusted, no attachments, ≤5
 *          external, global switch on) — each failed condition is spelled out
 *          in `reasons`.
 *
 * Also pins: no-context calls reproduce decideComposeMode byte-for-byte (the
 * human/trusted-source lane is untouched), and the address helpers.
 */

function agent(level: AgentAutonomyLevel, recipientPolicy: unknown = null): AutonomyAgent {
  return { key: 'bot', autonomyLevel: level, recipientPolicy };
}

function ctx(overrides: Partial<AgentComposeContext> = {}): AgentComposeContext {
  return {
    mailboxClass: 'agent',
    internalDomains: ['magicunicorn.tech'],
    recipients: ['jane@acme.test'],
    isInThreadReplyToInbound: true,
    attachmentCount: 0,
    trustedAddresses: new Set(['jane@acme.test']),
    autonomousSendEnabled: true,
    ...overrides,
  };
}

const codes = (d: { reasons: { code: string }[] }) => d.reasons.map((r) => r.code);

describe('decideAgentComposeMode — the Wave-7 matrix', () => {
  describe('no context / no agent → EXACTLY the base gate (compat lane)', () => {
    it.each([
      [{ requestedMode: 'send' as const, agent: null, toAddress: 'x@y.z', trustedUnregisteredSend: true }],
      [{ requestedMode: 'send' as const, agent: null, toAddress: 'x@y.z', trustedUnregisteredSend: false }],
      [{ requestedMode: 'draft' as const, agent: null, toAddress: 'x@y.z' }],
      [{ requestedMode: 'draft' as const, agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT), toAddress: 'x@y.z' }],
      [{ requestedMode: 'send' as const, agent: agent(AgentAutonomyLevel.L0_DRAFT_ONLY), toAddress: 'x@y.z' }],
      [{ requestedMode: 'send' as const, agent: agent(AgentAutonomyLevel.L1_APPROVE_TO_SEND), toAddress: 'x@y.z' }],
      [{ requestedMode: 'send' as const, agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT), toAddress: 'x@y.z' }],
      [
        {
          requestedMode: 'send' as const,
          agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, {
            requireApprovalForExternal: true,
            internalDomains: ['magicunicorn.tech'],
          }),
          toAddress: 'person114@example.com',
        },
      ],
    ])('mirrors decideComposeMode for %j', (args) => {
      const base = decideComposeMode(args);
      const matrix = decideAgentComposeMode(args);
      expect(matrix.mode).toBe(base.mode);
      expect(matrix.coerced).toBe(base.coerced);
      expect(matrix.reason).toBe(base.reason);
    });

    it('a coerced base decision surfaces exactly one reason entry; a send has none', () => {
      const coerced = decideAgentComposeMode({
        requestedMode: 'send',
        agent: null,
        toAddress: 'x@y.z',
        trustedUnregisteredSend: false,
      });
      expect(coerced.reasons).toEqual([
        expect.objectContaining({ code: 'untrusted-source', message: expect.any(String) }),
      ]);
      const sent = decideAgentComposeMode({
        requestedMode: 'send',
        agent: null,
        toAddress: 'x@y.z',
        trustedUnregisteredSend: true,
      });
      expect(sent.mode).toBe('send');
      expect(sent.reasons).toEqual([]);
    });

    it('a requested draft WITH a context is still honored unconditionally (no matrix, no reasons)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'draft',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'x@y.z',
        agentContext: ctx(),
      });
      expect(d).toMatchObject({ mode: 'draft', coerced: false, reason: 'requested-draft', reasons: [] });
    });
  });

  describe('Class A — a human/shared/unknown mailbox ALWAYS stages, any level', () => {
    it.each([
      [AgentAutonomyLevel.L0_DRAFT_ONLY, 'user' as const],
      [AgentAutonomyLevel.L1_APPROVE_TO_SEND, 'user' as const],
      [AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, 'user' as const],
      [AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, 'unknown' as const],
    ])('%s from a %s mailbox → draft (class-a-mailbox)', (level, mailboxClass) => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(level),
        toAddress: 'in@magicunicorn.tech',
        agentContext: ctx({
          mailboxClass,
          recipients: ['in@magicunicorn.tech'], // even ALL-INTERNAL holds on Class A
        }),
      });
      expect(d.mode).toBe('draft');
      expect(d.coerced).toBe(true);
      expect(codes(d)).toEqual(['class-a-mailbox']);
    });
  });

  describe('Class B / L0 — draft-only, everything stages', () => {
    it('all-internal, in-thread, trusted — still a draft (l0-draft-only)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L0_DRAFT_ONLY),
        toAddress: 'in@magicunicorn.tech',
        agentContext: ctx({ recipients: ['in@magicunicorn.tech'] }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['l0-draft-only']);
    });
  });

  describe('Class B / L1 — internal-autonomous (the new semantics)', () => {
    it('every recipient internal → SEND', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L1_APPROVE_TO_SEND),
        toAddress: 'a@magicunicorn.tech',
        agentContext: ctx({
          recipients: ['a@magicunicorn.tech', 'b@magicunicorn.tech'],
          // Not a reply, nothing trusted — irrelevant for the internal lane.
          isInThreadReplyToInbound: false,
          trustedAddresses: new Set(),
        }),
      });
      expect(d).toMatchObject({ mode: 'send', coerced: false, reason: 'L1-internal-autonomous' });
      expect(d.reasons).toEqual([]);
    });

    it('ONE external among internals → draft (l1-external), even trusted + in-thread', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L1_APPROVE_TO_SEND),
        toAddress: 'a@magicunicorn.tech',
        agentContext: ctx({
          recipients: ['a@magicunicorn.tech', 'jane@acme.test'],
        }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['l1-external']);
      expect(d.reasons[0].message).toContain('jane@acme.test');
    });

    it('the agent recipientPolicy.internalDomains extend the internal set', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L1_APPROVE_TO_SEND, { internalDomains: ['acme.test'] }),
        toAddress: 'jane@acme.test',
        // The service merges policy domains into the context's internalDomains.
        agentContext: ctx({
          internalDomains: ['magicunicorn.tech', 'acme.test'],
          recipients: ['jane@acme.test'],
        }),
      });
      expect(d.mode).toBe('send');
    });

    it('NO internal domains at all → everything is external → draft (fail-safe)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L1_APPROVE_TO_SEND),
        toAddress: 'a@magicunicorn.tech',
        agentContext: ctx({ internalDomains: [], recipients: ['a@magicunicorn.tech'] }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['l1-external']);
    });
  });

  describe('Class B / L2 — internal flows; external only when ROUTINE', () => {
    it('all-internal → SEND (no routine checklist consulted)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'a@magicunicorn.tech',
        agentContext: ctx({
          recipients: ['a@magicunicorn.tech'],
          isInThreadReplyToInbound: false,
          attachmentCount: 3, // internal mail may carry attachments
          trustedAddresses: new Set(),
          autonomousSendEnabled: true,
        }),
      });
      expect(d).toMatchObject({ mode: 'send', reason: 'L2-internal-autonomous' });
    });

    it('ROUTINE external (in-thread + trusted + no attachments + ≤5 + switch on) → SEND', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'jane@acme.test',
        agentContext: ctx(),
      });
      expect(d).toMatchObject({ mode: 'send', coerced: false, reason: 'L2-routine-external-autonomous' });
      expect(d.reasons).toEqual([]);
    });

    it('FIRST CONTACT (untrusted external) → draft with a per-address first-contact reason', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'jane@acme.test',
        agentContext: ctx({ trustedAddresses: new Set() }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['first-contact']);
      expect(d.reasons[0].message).toBe(
        'First contact with jane@acme.test — approve once to trust this correspondent.',
      );
    });

    it('COLD OUTBOUND (not an in-thread reply to their inbound) → draft (cold-outbound)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'jane@acme.test',
        agentContext: ctx({ isInThreadReplyToInbound: false }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['cold-outbound']);
    });

    it('ATTACHMENTS → draft (attachment)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'jane@acme.test',
        agentContext: ctx({ attachmentCount: 1 }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['attachment']);
    });

    it(`BULK (> ${MAX_ROUTINE_EXTERNAL_RECIPIENTS} external) → draft (bulk-external)`, () => {
      const recipients = Array.from({ length: 6 }, (_, i) => `p${i}@acme.test`);
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: recipients[0],
        agentContext: ctx({ recipients, trustedAddresses: new Set(recipients) }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['bulk-external']);
    });

    it('EXACTLY 5 trusted external in-thread recipients still SEND (the bound is inclusive)', () => {
      const recipients = Array.from({ length: 5 }, (_, i) => `p${i}@acme.test`);
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: recipients[0],
        agentContext: ctx({ recipients, trustedAddresses: new Set(recipients) }),
      });
      expect(d.mode).toBe('send');
    });

    it('GLOBAL SWITCH off → draft (autonomous-send-disabled)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'jane@acme.test',
        agentContext: ctx({ autonomousSendEnabled: false }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['autonomous-send-disabled']);
    });

    it('EVERY failed condition is reported together (cold + attachment + first-contact + bulk + switch)', () => {
      const recipients = Array.from({ length: 6 }, (_, i) => `p${i}@acme.test`);
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: recipients[0],
        agentContext: ctx({
          recipients,
          trustedAddresses: new Set(),
          isInThreadReplyToInbound: false,
          attachmentCount: 2,
          autonomousSendEnabled: false,
        }),
      });
      expect(d.mode).toBe('draft');
      const set = new Set(codes(d));
      expect(set).toEqual(
        new Set(['autonomous-send-disabled', 'cold-outbound', 'attachment', 'bulk-external', 'first-contact']),
      );
      // Per-address first-contact entries are capped at 5 + a summary line.
      expect(d.reasons.filter((r) => r.code === 'first-contact')).toHaveLength(6);
    });

    it('ONE untrusted among several trusted externals is enough to hold (every external must be trusted)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
        toAddress: 'jane@acme.test',
        agentContext: ctx({
          recipients: ['jane@acme.test', 'new@corp.test'],
          trustedAddresses: new Set(['jane@acme.test']),
        }),
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['first-contact']);
      expect(d.reasons[0].message).toContain('new@corp.test');
    });

    it('the per-agent requireApprovalForExternal dial still binds (stricter than routine)', () => {
      const d = decideAgentComposeMode({
        requestedMode: 'send',
        agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, { requireApprovalForExternal: true }),
        toAddress: 'jane@acme.test',
        agentContext: ctx(), // fully routine — the dial still holds it
      });
      expect(d.mode).toBe('draft');
      expect(codes(d)).toEqual(['l2-external-policy']);
    });
  });
});

describe('address helpers (pure)', () => {
  it('normalizeAddress: bare, angled, cased, padded — all → bare lowercase', () => {
    expect(normalizeAddress('Jane@Acme.TEST')).toBe('jane@acme.test');
    expect(normalizeAddress('Jane Doe <Jane@Acme.test>')).toBe('jane@acme.test');
    expect(normalizeAddress('  "J" <j@a.b>  ')).toBe('j@a.b');
    expect(normalizeAddress('not-an-email')).toBe('not-an-email');
    expect(normalizeAddress('')).toBe('');
  });

  it('splitRecipients: unparseable/empty domains classify EXTERNAL (the safer side)', () => {
    const { internal, external } = splitRecipients(
      ['a@in.test', 'b@out.test', 'garbage', ''],
      ['in.test'],
    );
    expect(internal).toEqual(['a@in.test']);
    expect(external).toEqual(['b@out.test', 'garbage', '']);
  });
});
