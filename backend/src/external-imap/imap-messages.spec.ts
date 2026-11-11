import { FetchMessageObject } from 'imapflow';
import { laneForMailbox, routingTable } from '../mail-provider/mail-routing';
import { bodyParts, groupMessages, references } from './imap-messages';

function message(uid: number, id?: string, refs?: string, reply?: string): FetchMessageObject {
  return {
    uid,
    seq: uid,
    envelope: { messageId: id, inReplyTo: reply },
    headers: Buffer.from(`References: ${refs ?? ''}\r\n\r\n`),
  };
}
describe('IMAP thread and MIME mapping', () => {
  it('labels IMAP routing as read-only, including when the connector is disabled', () => {
    const mailbox = { provider: 'external_imap', emailAddress: 'reader@example.com', active: true };
    expect(laneForMailbox(mailbox)).toBe('read_only');
    expect(routingTable([mailbox])[0].lane).toBe('read_only');
  });
  it('merges references through missing parents and In-Reply-To, independent of fetch order', () => {
    const a = message(1, '<a@example.com>');
    const b = message(2, '<b@example.com>', '<a@example.com>\r\n <missing@example.com>');
    const c = message(3, '<c@example.com>', undefined, '<b@example.com>');
    expect(references(b)).toEqual(['<a@example.com>', '<missing@example.com>']);
    const ordered = groupMessages([a, b, c], '42');
    const shuffled = groupMessages([c, b, a], '42');
    expect([...ordered.keys()]).toEqual([...shuffled.keys()]);
    expect([...ordered.values()][0]).toHaveLength(3);
  });
  it('does not group unrelated subjects and isolates missing Message-IDs by UIDVALIDITY/UID', () => {
    const messages = [message(1), message(2), message(3, '<three@example.com>')];
    expect(groupMessages(messages, '42').size).toBe(3);
    expect([...groupMessages(messages, '42').keys()]).not.toEqual([
      ...groupMessages(messages, '43').keys(),
    ]);
  });
  it('gives duplicate IDs one thread and tolerates cyclic or self references', () => {
    const messages = [
      message(1, '<a@example.com>', '<b@example.com>'),
      message(2, '<b@example.com>', '<a@example.com>'),
      message(3, '<a@example.com>', '<a@example.com>'),
    ];
    expect(groupMessages(messages, '42').size).toBe(1);
  });
  it('preserves a thread id when replies arrive', () => {
    const root = message(1, '<root@example.com>');
    const reply = message(2, '<earlier-sorting@example.com>', '<root@example.com>');
    expect([...groupMessages([root], '42').keys()]).toEqual([
      ...groupMessages([reply, root], '42').keys(),
    ]);
  });
  it('separates body alternatives, inline images and attached text/messages', () => {
    const parts = bodyParts({
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          part: '1',
          childNodes: [
            { type: 'text/plain', part: '1.1' },
            { type: 'text/html', part: '1.2' },
          ],
        },
        { type: 'image/png', part: '2', disposition: 'inline', id: '<image@example.com>' },
        { type: 'text/plain', part: '3', disposition: 'attachment' },
        {
          type: 'message/rfc822',
          part: '4',
          disposition: 'attachment',
          childNodes: [{ type: 'text/plain', part: '4.1' }],
        },
      ],
    });
    expect(parts.body.map((p) => p.part)).toEqual(['1.1', '1.2']);
    expect(parts.attachments.map((p) => p.part)).toEqual(['2', '3', '4']);
    expect(bodyParts({ type: 'text/plain' }).body[0].part).toBe('1');
  });
});
