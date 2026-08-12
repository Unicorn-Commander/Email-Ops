/**
 * The routing rule is the thing most likely to rot silently (a mail that was
 * supposed to leave @magicunicorn.tech quietly leaving @magicunicorn.dev), so it
 * gets its own pure unit test rather than only being exercised end-to-end.
 */
import {
  domainOf,
  isExternalLane,
  laneForMailbox,
  normalizeAddress,
  routeFromAddress,
  routingTable,
  RoutableMailbox,
} from './mail-routing';

// The real dogfood workspace shape (aaron@magicunicorn.tech is M365).
const MAILBOXES: RoutableMailbox[] = [
  { id: 'ms', emailAddress: 'aaron@magicunicorn.tech', provider: 'microsoft', active: true },
  { id: 'dev', emailAddress: 'aaron@magicunicorn.dev', provider: 'stalwart', active: true },
  { id: 'studio', emailAddress: 'aaron@majiks.studio', provider: 'stalwart', active: true },
  { id: 'gm', emailAddress: 'person5@example.com', provider: 'gmail', active: true },
  { id: 'off', emailAddress: 'retired@magicunicorn.dev', provider: 'stalwart', active: false },
];

describe('mail-routing', () => {
  describe('laneForMailbox', () => {
    it('routes microsoft to graph', () => {
      expect(laneForMailbox({ provider: 'microsoft' })).toBe('graph');
    });
    it('routes gmail to the gmail api', () => {
      expect(laneForMailbox({ provider: 'gmail' })).toBe('gmail');
    });
    it('routes stalwart to james', () => {
      expect(laneForMailbox({ provider: 'stalwart' })).toBe('james');
    });
    it('defaults an unknown/legacy provider to the sovereign engine', () => {
      // Every pre-existing row defaults to 'stalwart'; an unrecognised value must
      // never accidentally become an external send.
      expect(laneForMailbox({ provider: 'something-new' })).toBe('james');
    });
  });

  describe('routeFromAddress', () => {
    it('sends @magicunicorn.tech through Microsoft Graph', () => {
      const r = routeFromAddress('aaron@magicunicorn.tech', MAILBOXES);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.lane).toBe('graph');
        expect(r.mailbox.id).toBe('ms');
      }
    });

    it('keeps @magicunicorn.dev on James (regression: sovereign unchanged)', () => {
      const r = routeFromAddress('aaron@magicunicorn.dev', MAILBOXES);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lane).toBe('james');
    });

    it('keeps @majiks.studio on James (regression: sovereign unchanged)', () => {
      const r = routeFromAddress('aaron@majiks.studio', MAILBOXES);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lane).toBe('james');
    });

    it('is case- and whitespace-insensitive', () => {
      const r = routeFromAddress('  AAron@MagicUnicorn.TECH ', MAILBOXES);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.lane).toBe('graph');
    });

    it('FAILS LOUD for an unregistered address rather than falling back', () => {
      // The whole bug class: a .tech send silently leaving as the workspace
      // default. Unroutable must be an explicit refusal.
      const r = routeFromAddress('nobody@example.com', MAILBOXES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('no_registered_mailbox');
    });

    it('refuses an inactive mailbox explicitly', () => {
      const r = routeFromAddress('retired@magicunicorn.dev', MAILBOXES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('mailbox_inactive');
    });

    it('refuses an empty address', () => {
      const r = routeFromAddress('', MAILBOXES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('no_address');
    });
  });

  describe('helpers', () => {
    it('extracts the domain', () => {
      expect(domainOf('Aaron@MagicUnicorn.tech')).toBe('magicunicorn.tech');
      expect(domainOf('malformed')).toBe('');
    });

    it('normalizes addresses', () => {
      expect(normalizeAddress('  A@B.COM ')).toBe('a@b.com');
      expect(normalizeAddress(null)).toBe('');
    });

    it('classifies external lanes', () => {
      expect(isExternalLane('graph')).toBe(true);
      expect(isExternalLane('gmail')).toBe(true);
      expect(isExternalLane('james')).toBe(false);
    });

    it('builds a routing table that shows .tech is served (unlike list_mail_domains)', () => {
      const table = routingTable(MAILBOXES);
      const tech = table.find((t) => t.domain === 'magicunicorn.tech');
      expect(tech).toBeDefined();
      expect(tech?.lane).toBe('graph');
      // James-only domain listing would have omitted it entirely.
      expect(table.filter((t) => t.lane === 'james').map((t) => t.domain)).toEqual(
        expect.arrayContaining(['magicunicorn.dev', 'majiks.studio']),
      );
    });
  });
});
