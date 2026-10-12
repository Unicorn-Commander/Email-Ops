import { AgentInboxApprovalTier } from '@prisma/client';
import { classifyApprovalTier, DEFAULT_APPROVAL_KEYWORDS } from './approval-routing';

describe('classifyApprovalTier', () => {
  it.each([
    ['a price', 'The price is $900.', 'currency amount'],
    ['a discount', 'We can offer 20% off this week.', 'percentage'],
    ['a commitment', 'We commit to delivering Friday.', 'keyword'],
    ['a contract', 'Please review the contract attached.', 'keyword'],
  ])('routes %s to owner/admin', (_label, body, reason) => {
    const result = classifyApprovalTier(null, body);
    expect(result.tier).toBe(AgentInboxApprovalTier.OWNER_ADMIN);
    expect(result.matchedReason?.toLowerCase()).toContain(reason);
  });

  it('routes a routine reply to the mailbox owner', () => {
    expect(classifyApprovalTier('Re: Tuesday', 'Thanks, that works for me.')).toEqual({
      tier: AgentInboxApprovalTier.MAILBOX_OWNER,
      matchedReason: null,
    });
  });

  it('uses a workspace keyword override while retaining numeric matches', () => {
    expect(classifyApprovalTier(null, 'Please accept our renewal terms.', ['renewal'])).toEqual({
      tier: AgentInboxApprovalTier.OWNER_ADMIN,
      matchedReason: 'keyword: renewal',
    });
    expect(
      classifyApprovalTier(null, 'Routine note with no commercial terms.', ['renewal']).tier,
    ).toBe(AgentInboxApprovalTier.MAILBOX_OWNER);
    expect(DEFAULT_APPROVAL_KEYWORDS).toContain('contract');
  });
});
