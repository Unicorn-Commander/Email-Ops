import { ForbiddenException } from '@nestjs/common';
import { mayActThroughMailbox, assertMayActThroughMailbox } from './mailbox-fence';

describe('mailbox-fence', () => {
  const mockDb = {
    user: {
      findFirst: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('mayActThroughMailbox', () => {
    it('returns true for SHARED mailbox without DB lookup', async () => {
      const mb = { ownerKind: 'SHARED', ownerKey: null };
      const result = await mayActThroughMailbox(mockDb, mb, 'any-uid');
      expect(result).toBe(true);
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns true for AGENT mailbox without DB lookup', async () => {
      const mb = { ownerKind: 'AGENT', ownerKey: 'agent-1' };
      const result = await mayActThroughMailbox(mockDb, mb, 'any-uid');
      expect(result).toBe(true);
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns false for HUMAN mailbox with no ownerKey', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: null };
      const result = await mayActThroughMailbox(mockDb, mb, 'some-uid');
      expect(result).toBe(false);
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns false for HUMAN mailbox with no ucUid', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'owner-1' };
      const result = await mayActThroughMailbox(mockDb, mb, null);
      expect(result).toBe(false);
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns true for HUMAN mailbox with direct ownerKey match', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'owner-1' };
      const result = await mayActThroughMailbox(mockDb, mb, 'owner-1');
      expect(result).toBe(true);
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('returns true for HUMAN mailbox when ucUid matches keycloakId', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'kc-123' };
      mockDb.user.findFirst.mockResolvedValue({ id: 'local-1', keycloakId: 'kc-123' });
      const result = await mayActThroughMailbox(mockDb, mb, 'local-1');
      expect(result).toBe(true);
      expect(mockDb.user.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ keycloakId: 'local-1' }, { id: 'local-1' }] },
      });
    });

    it('returns true for HUMAN mailbox when ucUid matches local User.id', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'kc-123' };
      mockDb.user.findFirst.mockResolvedValue({ id: 'local-1', keycloakId: 'kc-123' });
      const result = await mayActThroughMailbox(mockDb, mb, 'local-1');
      expect(result).toBe(true);
      expect(mockDb.user.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ keycloakId: 'local-1' }, { id: 'local-1' }] },
      });
    });

    it('returns false for HUMAN mailbox when no identity match', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'kc-123' };
      mockDb.user.findFirst.mockResolvedValue(null);
      const result = await mayActThroughMailbox(mockDb, mb, 'other-uid');
      expect(result).toBe(false);
      expect(mockDb.user.findFirst).toHaveBeenCalledWith({
        where: { OR: [{ keycloakId: 'other-uid' }, { id: 'other-uid' }] },
      });
    });
  });

  describe('assertMayActThroughMailbox', () => {
    it('throws ForbiddenException for non-matching HUMAN mailbox', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'owner-1' };
      mockDb.user.findFirst.mockResolvedValue(null);
      await expect(assertMayActThroughMailbox(mockDb, mb, 'other-uid')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(assertMayActThroughMailbox(mockDb, mb, 'other-uid')).rejects.toThrow(
        'This mailbox is private to its owner.',
      );
    });

    it('does not throw for SHARED mailbox', async () => {
      const mb = { ownerKind: 'SHARED', ownerKey: null };
      await expect(assertMayActThroughMailbox(mockDb, mb, 'any-uid')).resolves.toBeUndefined();
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('does not throw for AGENT mailbox', async () => {
      const mb = { ownerKind: 'AGENT', ownerKey: 'agent-1' };
      await expect(assertMayActThroughMailbox(mockDb, mb, 'any-uid')).resolves.toBeUndefined();
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('does not throw for direct owner match', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'owner-1' };
      await expect(assertMayActThroughMailbox(mockDb, mb, 'owner-1')).resolves.toBeUndefined();
      expect(mockDb.user.findFirst).not.toHaveBeenCalled();
    });

    it('does not throw for fallback identity match', async () => {
      const mb = { ownerKind: 'HUMAN', ownerKey: 'kc-123' };
      mockDb.user.findFirst.mockResolvedValue({ id: 'local-1', keycloakId: 'kc-123' });
      await expect(assertMayActThroughMailbox(mockDb, mb, 'local-1')).resolves.toBeUndefined();
      expect(mockDb.user.findFirst).toHaveBeenCalled();
    });
  });
});
