import { verifiedInternalDomains } from './email.service';

describe('verified mail-domain send guard', () => {
  it('queries and returns only domains whose verified flag is true', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([{ domain: 'Trusted.TEST' }, { domain: 'second.test' }]);
    const tx = { mailDomain: { findMany } };

    await expect(verifiedInternalDomains(tx as never, 'ws-1')).resolves.toEqual(
      new Set(['trusted.test', 'second.test']),
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-1', verified: true },
      select: { domain: true },
    });
  });
});
