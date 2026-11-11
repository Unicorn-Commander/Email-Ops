import { Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { externalImapEnabled, ImapConnection, requireExternalImap } from './imap-connection';

describe('external IMAP workspace configuration', () => {
  const previousFlag = process.env.EXTERNAL_IMAP_ENABLED;
  const previousIds = process.env.EXTERNAL_IMAP_WORKSPACE_IDS;

  afterEach(() => {
    if (previousFlag === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = previousFlag;
    if (previousIds === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = previousIds;
    jest.restoreAllMocks();
  });

  it.each([
    [undefined, 'workspace-one', false],
    ['false', 'workspace-one', false],
    ['TRUE', 'workspace-one', false],
    ['true', 'workspace-one', true],
    ['true', ' workspace-two, ,workspace-one,workspace-one ', true],
    ['true', 'workspace-two', false],
    ['true', 'workspace-one-extra', false],
    ['true', 'WORKSPACE-ONE', false],
    ['true', '*', false],
    ['true', undefined, false],
    ['true', '', false],
    ['true', ' , , ', false],
  ])('flag %s and allowlist %s give enabled=%s', (flag, ids, enabled) => {
    if (flag === undefined) delete process.env.EXTERNAL_IMAP_ENABLED;
    else process.env.EXTERNAL_IMAP_ENABLED = flag;
    if (ids === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = ids;
    expect(externalImapEnabled('workspace-one')).toBe(enabled);
    expect(externalImapEnabled('')).toBe(false);
    if (enabled) expect(() => requireExternalImap('workspace-one')).not.toThrow();
    else expect(() => requireExternalImap('workspace-one')).toThrow(NotFoundException);
  });

  it.each([
    ['true', undefined, 1],
    ['true', '', 1],
    ['true', ' , , ', 1],
    ['true', 'workspace-one', 0],
    ['false', '', 0],
  ])('warns only at startup with flag %s and allowlist %s', async (flag, ids, count) => {
    process.env.EXTERNAL_IMAP_ENABLED = flag;
    if (ids === undefined) delete process.env.EXTERNAL_IMAP_WORKSPACE_IDS;
    else process.env.EXTERNAL_IMAP_WORKSPACE_IDS = ids;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const module = await Test.createTestingModule({ providers: [ImapConnection] }).compile();
    try {
      await module.init();
      for (let i = 0; i < 3; i++) externalImapEnabled('workspace-one');
      expect(warn).toHaveBeenCalledTimes(count);
      if (count) {
        expect(warn).toHaveBeenCalledWith(
          'EXTERNAL_IMAP_ENABLED is true but EXTERNAL_IMAP_WORKSPACE_IDS is empty; external IMAP is disabled for every workspace.',
        );
      }
    } finally {
      await module.close();
    }
  });
});
