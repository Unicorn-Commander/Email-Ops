import {
  DEFAULT_DIRECT_APPROVAL_SECONDS_BETWEEN,
  DEFAULT_KIT_APPROVAL_SECONDS_BETWEEN,
  planAgentInboxSchedule,
} from './agent-inbox-scheduler';

const NOW = new Date('2026-11-03T23:40:00.000Z');

describe('agent inbox bulk approval scheduler', () => {
  it('paces kit rows per sender while allowing independent senders to start together', () => {
    const plan = planAgentInboxSchedule(
      [
        {
          itemId: 'a1',
          sender: 'sales-a@example.test',
          kitId: 'kit-a',
          expiresAt: new Date('2026-11-04T01:00:00.000Z'),
          capPerDay: 10,
        },
        {
          itemId: 'b1',
          sender: 'sales-b@example.test',
          kitId: 'kit-b',
          expiresAt: new Date('2026-11-04T01:00:00.000Z'),
          capPerDay: 10,
        },
        {
          itemId: 'a2',
          sender: 'sales-a@example.test',
          kitId: 'kit-a',
          expiresAt: new Date('2026-11-04T01:00:00.000Z'),
          capPerDay: 10,
        },
      ],
      NOW,
    );

    expect(plan.scheduled.map((item) => item.sendAt.toISOString())).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
      new Date(NOW.getTime() + DEFAULT_KIT_APPROVAL_SECONDS_BETWEEN * 1000).toISOString(),
    ]);
    expect(plan.countPerSender).toEqual({
      'sales-a@example.test': 2,
      'sales-b@example.test': 1,
    });
  });

  it('uses the two-second direct-draft floor and honors not_before', () => {
    const notBefore = new Date(NOW.getTime() + 10_000);
    const plan = planAgentInboxSchedule(
      [
        { itemId: 'direct-1', sender: 'desk@example.test' },
        { itemId: 'direct-2', sender: 'desk@example.test' },
        { itemId: 'direct-3', sender: 'desk@example.test', notBefore },
      ],
      NOW,
    );

    expect(plan.scheduled[1].sendAt.getTime() - plan.scheduled[0].sendAt.getTime()).toBe(
      DEFAULT_DIRECT_APPROVAL_SECONDS_BETWEEN * 1000,
    );
    expect(plan.scheduled[2].sendAt).toEqual(notBefore);
  });

  it('refuses expired kits and rows that would exceed the daily cap', () => {
    const plan = planAgentInboxSchedule(
      [
        {
          itemId: 'expired',
          sender: 'sales@example.test',
          kitId: 'expired-kit',
          expiresAt: new Date('2026-11-03T23:39:59.000Z'),
          capPerDay: 10,
        },
        {
          itemId: 'at-cap',
          sender: 'sales@example.test',
          kitId: 'capped-kit',
          expiresAt: new Date('2026-11-04T01:00:00.000Z'),
          capPerDay: 2,
          sentToday: 2,
        },
        {
          itemId: 'one-left',
          sender: 'sales@example.test',
          kitId: 'capped-kit',
          expiresAt: new Date('2026-11-04T01:00:00.000Z'),
          capPerDay: 3,
          sentToday: 2,
        },
        {
          itemId: 'over-batch',
          sender: 'sales@example.test',
          kitId: 'capped-kit',
          expiresAt: new Date('2026-11-04T01:00:00.000Z'),
          capPerDay: 3,
          sentToday: 2,
        },
      ],
      NOW,
    );

    expect(plan.refused).toEqual([
      { itemId: 'expired', reason: 'kit_expired' },
      { itemId: 'at-cap', reason: 'cap_reached' },
      { itemId: 'over-batch', reason: 'cap_reached' },
    ]);
    expect(plan.scheduled.map((item) => item.itemId)).toEqual(['one-left']);
  });
});
