/**
 * A thread belongs to a live JMAP folder when at least one of its messages
 * belongs to that folder's mailbox. JMAP's collapsed thread projection can
 * otherwise retain a thread whose representative message lives in another
 * mailbox (for example, a Sent-only thread appearing in Inbox).
 */
export interface MailboxMembershipMessage {
  mailboxIds?: Record<string, unknown> | null;
}

export function threadHasMessageInMailbox(
  messages: readonly MailboxMembershipMessage[],
  mailboxId: string,
): boolean {
  return messages.some((message) => message.mailboxIds?.[mailboxId] === true);
}
