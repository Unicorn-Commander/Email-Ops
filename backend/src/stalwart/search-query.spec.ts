import { parseSearchQuery, buildJmapFilter } from './search-query';

describe('parseSearchQuery', () => {
  it('returns empty text for null / undefined / empty string', () => {
    expect(parseSearchQuery(null)).toEqual({ text: '' });
    expect(parseSearchQuery(undefined)).toEqual({ text: '' });
    expect(parseSearchQuery('')).toEqual({ text: '' });
    expect(parseSearchQuery('   ')).toEqual({ text: '' });
  });

  it('returns plain free text as-is', () => {
    expect(parseSearchQuery('hello')).toEqual({ text: 'hello' });
    expect(parseSearchQuery('hello world')).toEqual({ text: 'hello world' });
  });

  it('parses from: operator', () => {
    expect(parseSearchQuery('from:alice@example.com')).toEqual({
      text: '',
      from: 'alice@example.com',
    });
  });

  it('parses to: operator', () => {
    expect(parseSearchQuery('to:bob@example.com')).toEqual({
      text: '',
      to: 'bob@example.com',
    });
  });

  it('parses subject: operator with unquoted value', () => {
    expect(parseSearchQuery('subject:report')).toEqual({
      text: '',
      subject: 'report',
    });
  });

  it('parses subject: operator with quoted value preserving spaces', () => {
    expect(parseSearchQuery('subject:"quarterly report"')).toEqual({
      text: '',
      subject: 'quarterly report',
    });
  });

  it('parses has:attachment', () => {
    expect(parseSearchQuery('has:attachment')).toEqual({
      text: '',
      hasAttachment: true,
    });
  });

  it('treats has: with non-attachment value as free text', () => {
    const result = parseSearchQuery('has:starred');
    expect(result.hasAttachment).toBeUndefined();
    expect(result.text).toContain('has:starred');
  });

  it('parses before: with a valid ISO date', () => {
    expect(parseSearchQuery('before:2024-01-15')).toEqual({
      text: '',
      before: '2024-01-15',
    });
  });

  it('parses after: with a valid ISO date', () => {
    expect(parseSearchQuery('after:2024-06-01')).toEqual({
      text: '',
      after: '2024-06-01',
    });
  });

  it('rejects invalid before: dates as free text', () => {
    const r = parseSearchQuery('before:not-a-date');
    expect(r.before).toBeUndefined();
    expect(r.text).toContain('before:not-a-date');
  });

  it('rejects non-date format before: values as free text', () => {
    const r = parseSearchQuery('before:13-01-2024');
    expect(r.before).toBeUndefined();
    expect(r.text).toContain('13-01-2024');
  });

  it('rejects invalid after: dates (Feb 30) as free text', () => {
    const r = parseSearchQuery('after:2024-02-30');
    expect(r.after).toBeUndefined();
    expect(r.text).toContain('after:2024-02-30');
  });

  it('rejects after: with non-numeric value as free text', () => {
    const r = parseSearchQuery('after:yesterday');
    expect(r.after).toBeUndefined();
    expect(r.text).toContain('after:yesterday');
  });

  it('handles a combined query with multiple operators and free text', () => {
    const r = parseSearchQuery(
      'from:alice@example.com subject:"project alpha" invoice has:attachment'
    );
    expect(r.from).toBe('alice@example.com');
    expect(r.subject).toBe('project alpha');
    expect(r.hasAttachment).toBe(true);
    expect(r.text).toBe('invoice');
  });

  it('handles case-insensitive operator keys', () => {
    const r = parseSearchQuery('FROM:admin@x.com SUBJECT:test');
    expect(r.from).toBe('admin@x.com');
    expect(r.subject).toBe('test');
  });

  it('preserves free-text order among operators', () => {
    const r = parseSearchQuery('urgent from:x@y.com please');
    expect(r.text).toBe('urgent please');
    expect(r.from).toBe('x@y.com');
  });

  it('treats malformed quoted value in operator as free text', () => {
    const r = parseSearchQuery('from:"unclosed');
    expect(r.from).toBeUndefined();
    expect(r.text).toContain('from:');
  });

  it('treats empty quoted operator value as free text', () => {
    const r = parseSearchQuery('from:""');
    expect(r.from).toBeUndefined();
    expect(r.text).toContain('from:');
  });

  it('parses cc: operator', () => {
    expect(parseSearchQuery('cc:bob@example.com')).toEqual({
      text: '',
      cc: 'bob@example.com',
    });
  });

  it('parses is:unread operator', () => {
    expect(parseSearchQuery('is:unread')).toEqual({
      text: '',
      isUnread: true,
    });
  });

  it('parses is:read operator', () => {
    expect(parseSearchQuery('is:read')).toEqual({
      text: '',
      isRead: true,
    });
  });

  it('parses is:starred operator', () => {
    expect(parseSearchQuery('is:starred')).toEqual({
      text: '',
      isStarred: true,
    });
  });

  it('parses is:flagged operator as is:starred', () => {
    expect(parseSearchQuery('is:flagged')).toEqual({
      text: '',
      isStarred: true,
    });
  });

  it('treats unknown is: value as free text', () => {
    const r = parseSearchQuery('is:important');
    expect(r.isUnread).toBeUndefined();
    expect(r.isRead).toBeUndefined();
    expect(r.isStarred).toBeUndefined();
    expect(r.text).toContain('is:important');
  });

  it('handles duplicate operators with last-wins convention', () => {
    const r = parseSearchQuery('from:a@b.com from:c@d.com');
    expect(r.from).toBe('c@d.com');
  });

  it('does not throw on garbage input', () => {
    expect(() => parseSearchQuery('from: :: before:not-a-date')).not.toThrow();
    const r = parseSearchQuery('from: :: before:not-a-date');
    expect(r.from).toBeUndefined();
    expect(r.before).toBeUndefined();
    expect(r.text).toBeTruthy();
  });
});

describe('buildJmapFilter', () => {
  it('returns empty object for empty parse with no mailbox', () => {
    expect(buildJmapFilter({ text: '' })).toEqual({});
  });

  it('returns inMailbox condition when only mailbox given', () => {
    expect(buildJmapFilter({ text: '' }, 'mb-1')).toEqual({
      inMailbox: 'mb-1',
    });
  });

  it('returns single condition for free text', () => {
    expect(buildJmapFilter({ text: 'hello' })).toEqual({ text: 'hello' });
  });

  it('returns single condition for from', () => {
    expect(buildJmapFilter({ text: '', from: 'a@b.com' })).toEqual({
      from: 'a@b.com',
    });
  });

  it('returns single condition for to', () => {
    expect(buildJmapFilter({ text: '', to: 'b@c.com' })).toEqual({
      to: 'b@c.com',
    });
  });

  it('returns single condition for subject', () => {
    expect(buildJmapFilter({ text: '', subject: 'hello' })).toEqual({
      subject: 'hello',
    });
  });

  it('returns single condition for hasAttachment', () => {
    expect(buildJmapFilter({ text: '', hasAttachment: true })).toEqual({
      hasAttachment: true,
    });
  });

  it('formats before as ISO datetime', () => {
    expect(buildJmapFilter({ text: '', before: '2024-01-15' })).toEqual({
      before: '2024-01-15T00:00:00Z',
    });
  });

  it('formats after as ISO datetime', () => {
    expect(buildJmapFilter({ text: '', after: '2024-06-01' })).toEqual({
      after: '2024-06-01T00:00:00Z',
    });
  });

  it('ANDs multiple conditions together', () => {
    const result = buildJmapFilter({
      text: 'invoice',
      from: 'alice@example.com',
      hasAttachment: true,
    });
    expect(result).toEqual({
      operator: 'AND',
      conditions: [
        { text: 'invoice' },
        { from: 'alice@example.com' },
        { hasAttachment: true },
      ],
    });
  });

  it('includes inMailboxId when provided with other conditions', () => {
    const result = buildJmapFilter({ text: 'hello' }, 'mb-1');
    expect(result).toEqual({
      operator: 'AND',
      conditions: [{ text: 'hello' }, { inMailbox: 'mb-1' }],
    });
  });

  it('combines all field types into AND', () => {
    const result = buildJmapFilter(
      {
        text: 'receipt',
        from: 'store@example.com',
        to: 'me@example.com',
        cc: 'manager@example.com',
        subject: 'order',
        hasAttachment: true,
        isUnread: true,
        isStarred: true,
        before: '2024-03-01',
        after: '2024-01-01',
      },
      'inbox-id'
    );
    expect(result).toEqual({
      operator: 'AND',
      conditions: [
        { text: 'receipt' },
        { from: 'store@example.com' },
        { to: 'me@example.com' },
        { cc: 'manager@example.com' },
        { subject: 'order' },
        { hasAttachment: true },
        { notKeyword: '$seen' },
        { hasKeyword: '$flagged' },
        { before: '2024-03-01T00:00:00Z' },
        { after: '2024-01-01T00:00:00Z' },
        { inMailbox: 'inbox-id' },
      ],
    });
  });

  it('maps is:unread to the JMAP notKeyword $seen filter', () => {
    expect(buildJmapFilter({ text: '', isUnread: true })).toEqual({ notKeyword: '$seen' });
  });

  it('maps is:read to the JMAP hasKeyword $seen filter', () => {
    expect(buildJmapFilter({ text: '', isRead: true })).toEqual({ hasKeyword: '$seen' });
  });

  it('maps is:starred to the JMAP hasKeyword $flagged filter', () => {
    expect(buildJmapFilter({ text: '', isStarred: true })).toEqual({ hasKeyword: '$flagged' });
  });

  it('handles unknown key:value as free text', () => {
    const parsed = parseSearchQuery('foo:bar hello');
    expect(parsed.text).toBe('foo:bar hello');
    expect(buildJmapFilter(parsed)).toEqual({ text: 'foo:bar hello' });
  });
});
