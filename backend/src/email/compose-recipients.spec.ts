import { BadRequestException } from '@nestjs/common';
import {
  deriveReplyAll,
  mergeReplyAll,
  parseExplicitRecipients,
  toResolved,
} from './compose-recipients';

describe('compose-recipients', () => {
  describe('parseExplicitRecipients', () => {
    it('keeps a single to_address as the To list', () => {
      expect(parseExplicitRecipients({ toAddress: 'a@acme.test' })).toEqual({
        to: ['a@acme.test'],
        cc: [],
        bcc: [],
      });
    });

    it('splits a comma-joined to_address (REST webmail shape)', () => {
      expect(parseExplicitRecipients({ toAddress: 'a@acme.test, b@acme.test' }).to).toEqual([
        'a@acme.test',
        'b@acme.test',
      ]);
    });

    it('uses to_addresses as authoritative when it starts with to_address', () => {
      const r = parseExplicitRecipients({
        toAddress: 'a@acme.test',
        toAddresses: ['a@acme.test', 'b@acme.test'],
        cc: ['c@acme.test'],
        bcc: ['d@acme.test'],
      });
      expect(r).toEqual({
        to: ['a@acme.test', 'b@acme.test'],
        cc: ['c@acme.test'],
        bcc: ['d@acme.test'],
      });
    });

    it('rejects to_address that is not the first to_addresses entry', () => {
      expect(() =>
        parseExplicitRecipients({
          toAddress: 'a@acme.test',
          toAddresses: ['b@acme.test', 'a@acme.test'],
        }),
      ).toThrow(BadRequestException);
    });

    it('dedupes case-insensitively and drops a Cc that is already in To', () => {
      const r = parseExplicitRecipients({
        toAddresses: ['A@acme.test', 'a@acme.test'],
        cc: ['a@acme.test', 'c@acme.test'],
      });
      expect(r.to).toEqual(['A@acme.test']);
      expect(r.cc).toEqual(['c@acme.test']);
    });

    it('rejects an address that appears in both To and Bcc', () => {
      expect(() =>
        parseExplicitRecipients({
          toAddress: 'a@acme.test',
          bcc: ['a@acme.test'],
        }),
      ).toThrow(/To\/Cc and Bcc/);
    });

    it('rejects a malformed address', () => {
      expect(() => parseExplicitRecipients({ toAddress: 'not-an-email' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('deriveReplyAll', () => {
    it('matches Outlook: To = From, Cc = original To+Cc minus self and From', () => {
      const r = deriveReplyAll({
        from: 'alice@acme.test',
        to: ['me@magicunicorn.tech', 'bob@acme.test'],
        cc: ['jordan@acme.test'],
        selfAddress: 'me@magicunicorn.tech',
      });
      expect(r.to).toEqual(['alice@acme.test']);
      expect(r.cc).toEqual(['bob@acme.test', 'jordan@acme.test']);
    });

    it('when From is self (reply-all on a sent item), To = first other, Cc = rest', () => {
      const r = deriveReplyAll({
        from: 'me@magicunicorn.tech',
        to: ['alice@acme.test', 'bob@acme.test'],
        cc: ['jordan@acme.test'],
        selfAddress: 'me@magicunicorn.tech',
      });
      expect(r.to).toEqual(['alice@acme.test']);
      expect(r.cc).toEqual(['bob@acme.test', 'jordan@acme.test']);
    });
  });

  describe('mergeReplyAll', () => {
    it('appends explicit extras on top of the derived set', () => {
      const derived = deriveReplyAll({
        from: 'alice@acme.test',
        to: ['me@magicunicorn.tech'],
        cc: ['jordan@acme.test'],
        selfAddress: 'me@magicunicorn.tech',
      });
      const merged = mergeReplyAll(derived, {
        to: ['shafen@acme.test'],
        cc: [],
        bcc: ['secret@acme.test'],
      });
      expect(merged.to).toEqual(['alice@acme.test', 'shafen@acme.test']);
      expect(merged.cc).toEqual(['jordan@acme.test']);
      expect(merged.bcc).toEqual(['secret@acme.test']);
    });
  });

  describe('toResolved', () => {
    it('rejects an empty To', () => {
      expect(() => toResolved({ to: [], cc: [], bcc: [] })).toThrow(/at least one To/);
    });

    it('sets toAddress to the first To', () => {
      expect(toResolved({ to: ['a@x.test', 'b@x.test'], cc: [], bcc: [] })).toEqual({
        toAddress: 'a@x.test',
        toAddresses: ['a@x.test', 'b@x.test'],
        cc: [],
        bcc: [],
      });
    });
  });
});
