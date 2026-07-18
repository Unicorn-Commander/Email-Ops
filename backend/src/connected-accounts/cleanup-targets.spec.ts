import {
  MAX_TARGET_ROWS,
  cleanupTargetsFromPlan,
  cleanupVerb,
  displaySender,
} from './cleanup-targets';

describe('cleanup-targets (pure preview logic)', () => {
  describe('cleanupVerb', () => {
    it.each([
      ['TRASH', 'Move to Trash'],
      ['trash', 'Move to Trash'],
      ['DELETE', 'Permanently delete'],
      ['ARCHIVE_PURGE', 'Permanently delete'],
      ['ARCHIVE', 'Archive'],
      ['ORGANIZE', 'Archive'],
      ['LABEL', 'Archive'],
      ['', 'Move to Trash'],
      [null, 'Move to Trash'],
    ])('maps %s → %s', (action, expected) => {
      expect(cleanupVerb(action as string)).toBe(expected);
    });
  });

  describe('displaySender', () => {
    it('extracts the display name from a "Name <addr>" sender', () => {
      expect(displaySender('Jane Doe <jane@acme.com>')).toBe('Jane Doe');
      expect(displaySender('"Ops, Team" <ops@x.io>')).toBe('Ops, Team');
    });
    it('keeps a bare address', () => {
      expect(displaySender('news@shop.com')).toBe('news@shop.com');
    });
    it('degrades to a placeholder when empty', () => {
      expect(displaySender(null)).toBe('(unknown sender)');
      expect(displaySender('   ')).toBe('(unknown sender)');
    });
  });

  describe('cleanupTargetsFromPlan', () => {
    const plan = {
      counts: { reviewed: 12, safe: 10, protected: 2 },
      freesBytes: 2048,
      safe: [
        { sender: 'News <news@shop.com>' },
        { sender: 'News <news@shop.com>' },
        { sender: 'News <news@shop.com>' },
        { sender: 'Deals <deals@shop.com>' },
        { sender: 'Deals <deals@shop.com>' },
        { sender: 'solo@once.com' },
      ],
    };

    it('groups the safe set by sender, sorted by count desc', () => {
      const t = cleanupTargetsFromPlan('TRASH', 'gmail', plan);
      expect(t.verb).toBe('Move to Trash');
      expect(t.scope).toBe('messages');
      expect(t.provider).toBe('gmail');
      expect(t.total).toBe(10); // from counts.safe, not the sample rows length
      expect(t.protected_count).toBe(2);
      expect(t.frees_bytes).toBe(2048);
      expect(t.rows[0]).toEqual({ sender: 'News', count: 3 });
      expect(t.rows[1]).toEqual({ sender: 'Deals', count: 2 });
      expect(t.rows[2]).toEqual({ sender: 'solo@once.com', count: 1 });
    });

    it('bounds rows to MAX_TARGET_ROWS and flags truncation', () => {
      const many = {
        counts: { safe: 20, protected: 0 },
        freesBytes: 0,
        safe: Array.from({ length: 20 }, (_, i) => ({ sender: `s${i}@x.com` })),
      };
      const t = cleanupTargetsFromPlan('ARCHIVE', 'microsoft', many);
      expect(t.verb).toBe('Archive');
      expect(t.rows).toHaveLength(MAX_TARGET_ROWS);
      expect(t.truncated).toBe(true);
    });

    it('degrades clean on an empty / missing plan', () => {
      const t = cleanupTargetsFromPlan('DELETE', 'gmail', null);
      expect(t.verb).toBe('Permanently delete');
      expect(t.total).toBe(0);
      expect(t.rows).toEqual([]);
      expect(t.truncated).toBe(false);
    });
  });
});
