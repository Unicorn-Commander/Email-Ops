import { threadHasMessageInMailbox } from './folder-predicate';

describe('threadHasMessageInMailbox', () => {
  const inbox = 'mailbox-inbox';
  const sent = 'mailbox-sent';

  it('excludes a thread whose only message is in Sent from Inbox', () => {
    const sentOnly = [{ mailboxIds: { [sent]: true } }];

    expect(threadHasMessageInMailbox(sentOnly, inbox)).toBe(false);
    expect(threadHasMessageInMailbox(sentOnly, sent)).toBe(true);
  });

  it('includes a mixed thread in both folders when each has a message', () => {
    const mixed = [
      { mailboxIds: { [inbox]: true } },
      { mailboxIds: { [sent]: true } },
    ];

    expect(threadHasMessageInMailbox(mixed, inbox)).toBe(true);
    expect(threadHasMessageInMailbox(mixed, sent)).toBe(true);
  });
});
