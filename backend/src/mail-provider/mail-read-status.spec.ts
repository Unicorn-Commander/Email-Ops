import {
  isMailReadUnavailable,
  mergeMailReadStatus,
  parseMailReadStatus,
  unwrapThreadMessages,
} from './mail-read-status';

describe('mail-read-status', () => {
  it.each([
    ['engine_not_configured', true],
    ['engine_unreachable', true],
    ['provider_auth_failed', true],
    ['provider_error', true],
    ['ok', false],
    [null, false],
    [undefined, false],
    ['empty', false],
  ] as const)('isMailReadUnavailable(%j) → %s', (status, expected) => {
    expect(isMailReadUnavailable(status)).toBe(expected);
  });

  it('parseMailReadStatus only accepts the typed statuses', () => {
    expect(parseMailReadStatus('provider_auth_failed')).toBe('provider_auth_failed');
    expect(parseMailReadStatus('nope')).toBe('ok');
    expect(parseMailReadStatus({ status: 'provider_error' })).toBe('ok');
  });

  it('mergeMailReadStatus stays ok when any mailbox produced threads', () => {
    expect(
      mergeMailReadStatus(['provider_auth_failed', 'ok'], 3),
    ).toBe('ok');
  });

  it('mergeMailReadStatus prefers reconnect over retry when the merge is empty', () => {
    expect(
      mergeMailReadStatus(
        ['engine_not_configured', 'provider_auth_failed', 'engine_unreachable'],
        0,
      ),
    ).toBe('provider_auth_failed');
    expect(mergeMailReadStatus(['engine_not_configured', 'ok'], 0)).toBe('engine_not_configured');
    expect(mergeMailReadStatus(['ok', 'ok'], 0)).toBe('ok');
  });

  it('unwrapThreadMessages accepts a bare array (older fakes) and a typed result', () => {
    expect(unwrapThreadMessages([{ id: 'm1' }])).toEqual({
      messages: [{ id: 'm1' }],
      status: 'ok',
    });
    expect(unwrapThreadMessages({ messages: [], status: 'provider_error' })).toEqual({
      messages: [],
      status: 'provider_error',
    });
  });
});
