import { AgentAutonomyLevel } from '@prisma/client';
import {
  decideComposeMode,
  isExternalRecipient,
  parseRecipientPolicy,
  type AutonomyAgent,
} from './autonomy';

/**
 * Autonomy-dial enforcement: the pure send-vs-draft decision. The contract is
 * conservative + opt-in — unregistered agents keep legacy behavior, a 'draft'
 * request is always honored, L0/L1 'send' is coerced to draft (human approves),
 * and L2 'send' is allowed unless a recipient policy gates external mail.
 */
describe('decideComposeMode', () => {
  const agent = (autonomyLevel: AgentAutonomyLevel, recipientPolicy: unknown = null): AutonomyAgent => ({
    key: 'customer-ops',
    autonomyLevel,
    recipientPolicy,
  });

  it('honors the requested mode for an UNREGISTERED agent (legacy — no enforcement)', () => {
    expect(decideComposeMode({ requestedMode: 'send', agent: null, toAddress: 'x@y.com' })).toEqual({
      mode: 'send',
      coerced: false,
      reason: 'unregistered-agent',
    });
    expect(decideComposeMode({ requestedMode: 'draft', agent: null, toAddress: 'x@y.com' }).mode).toBe(
      'draft',
    );
  });

  it('always honors a requested draft, even for an L2 agent', () => {
    const d = decideComposeMode({
      requestedMode: 'draft',
      agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
      toAddress: 'x@y.com',
    });
    expect(d).toEqual({ mode: 'draft', coerced: false, reason: 'requested-draft' });
  });

  it('coerces L0 send → draft (draft-only)', () => {
    const d = decideComposeMode({
      requestedMode: 'send',
      agent: agent(AgentAutonomyLevel.L0_DRAFT_ONLY),
      toAddress: 'x@y.com',
    });
    expect(d.mode).toBe('draft');
    expect(d.coerced).toBe(true);
    expect(d.reason).toContain('L0_DRAFT_ONLY');
  });

  it('coerces L1 send → draft (approve-to-send)', () => {
    const d = decideComposeMode({
      requestedMode: 'send',
      agent: agent(AgentAutonomyLevel.L1_APPROVE_TO_SEND),
      toAddress: 'x@y.com',
    });
    expect(d.mode).toBe('draft');
    expect(d.coerced).toBe(true);
    expect(d.reason).toContain('L1_APPROVE_TO_SEND');
  });

  it('allows an L2 send when there is no recipient policy', () => {
    const d = decideComposeMode({
      requestedMode: 'send',
      agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT),
      toAddress: 'anyone@anywhere.com',
    });
    expect(d).toEqual({ mode: 'send', coerced: false, reason: 'L2-autonomous-audited' });
  });

  it('coerces an L2 send to an EXTERNAL recipient when the policy requires approval', () => {
    const d = decideComposeMode({
      requestedMode: 'send',
      agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, {
        requireApprovalForExternal: true,
        internalDomains: ['magicunicorn.dev'],
      }),
      toAddress: 'person27@example.com',
    });
    expect(d.mode).toBe('draft');
    expect(d.coerced).toBe(true);
    expect(d.reason).toBe('L2-external-recipient-requires-approval');
  });

  it('allows an L2 send to an INTERNAL recipient under the same policy', () => {
    const d = decideComposeMode({
      requestedMode: 'send',
      agent: agent(AgentAutonomyLevel.L2_AUTONOMOUS_AUDIT, {
        requireApprovalForExternal: true,
        internalDomains: ['magicunicorn.dev'],
      }),
      toAddress: 'teammate@magicunicorn.dev',
    });
    expect(d.mode).toBe('send');
    expect(d.coerced).toBe(false);
  });
});

describe('isExternalRecipient', () => {
  it('treats a matching internal domain as internal', () => {
    expect(isExternalRecipient('a@magicunicorn.dev', ['magicunicorn.dev'])).toBe(false);
  });
  it('treats a non-matching domain as external', () => {
    expect(isExternalRecipient('person3@example.com', ['magicunicorn.dev'])).toBe(true);
  });
  it('treats an empty internal-domain list as everything-external', () => {
    expect(isExternalRecipient('a@magicunicorn.dev', [])).toBe(true);
  });
  it('treats an unparseable address as external (conservative)', () => {
    expect(isExternalRecipient('not-an-email', ['magicunicorn.dev'])).toBe(true);
  });
  it('is case-insensitive on the domain', () => {
    expect(isExternalRecipient('a@MagicUnicorn.DEV', ['magicunicorn.dev'])).toBe(false);
  });
});

describe('parseRecipientPolicy', () => {
  it('returns an empty policy for null/garbage', () => {
    expect(parseRecipientPolicy(null)).toEqual({ requireApprovalForExternal: false, internalDomains: [] });
    expect(parseRecipientPolicy('nope')).toEqual({ requireApprovalForExternal: false, internalDomains: [] });
  });
  it('normalizes internal domains (lowercase, strips a leading @)', () => {
    const p = parseRecipientPolicy({
      requireApprovalForExternal: true,
      internalDomains: ['@MagicUnicorn.dev', 'UnicornCommander.ai'],
    });
    expect(p.requireApprovalForExternal).toBe(true);
    expect(p.internalDomains).toEqual(['magicunicorn.dev', 'unicorncommander.ai']);
  });
});
