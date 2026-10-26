import { parseICalendarEvents, serializeICalendarEvent, zonedWallToUtc } from './icalendar';

describe('iCalendar parsing and UTC normalization', () => {
  it('expands daily and weekly recurrence and preserves the DST change in New York', () => {
    const data = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:weekly-demo',
      'DTSTART;TZID=America/New_York:20260301T090000',
      'DTEND;TZID=America/New_York:20260301T100000',
      'SUMMARY:Weekly planning',
      'RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=3',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:daily-demo',
      'DTSTART:20260310T140000Z',
      'DTEND:20260310T143000Z',
      'SUMMARY:Daily check',
      'RRULE:FREQ=DAILY;COUNT=3',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseICalendarEvents(
      data,
      new Date('2026-03-01T00:00:00.000Z'),
      new Date('2026-03-20T00:00:00.000Z'),
      'America/New_York',
    );

    expect(events.filter((event) => event.uid === 'weekly-demo')).toHaveLength(3);
    expect(events.filter((event) => event.uid === 'daily-demo')).toHaveLength(3);
    expect(events.find((event) => event.uid === 'weekly-demo')?.start).toBe('2026-03-01T14:00:00.000Z');
    expect(events.find((event) => event.uid === 'weekly-demo' && event.start.startsWith('2026-03-15'))?.start).toBe(
      '2026-03-15T13:00:00.000Z',
    );
    expect(events.find((event) => event.uid === 'weekly-demo')?.display_start).toContain('9:00');
  });

  it('handles all-day dates without shifting the displayed calendar day', () => {
    const data = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:all-day-demo',
      'DTSTART;VALUE=DATE:20261025',
      'DTEND;VALUE=DATE:20261027',
      'SUMMARY:Release window',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const [event] = parseICalendarEvents(
      data,
      new Date('2026-10-25T00:00:00.000Z'),
      new Date('2026-10-28T00:00:00.000Z'),
      'America/New_York',
    );
    expect(event.all_day).toBe(true);
    expect(event.start).toBe('2026-10-25T00:00:00.000Z');
    expect(event.end).toBe('2026-10-27T00:00:00.000Z');
    expect(event.display_start).toContain('Oct 25');
  });

  it('serializes timed events in UTC and all-day events as DATE values', () => {
    const timed = serializeICalendarEvent({
      uid: 'utc-demo',
      summary: 'UTC event',
      start: '2026-11-01T14:00:00.000Z',
      end: '2026-11-01T15:00:00.000Z',
      timezone: 'America/New_York',
      attendees: ['fictional@example.test'],
    });
    expect(timed).toContain('DTSTART:20261101T140000Z');
    expect(timed).toContain('DTEND:20261101T150000Z');
    expect(timed).toContain('ATTENDEE:mailto:fictional@example.test');

    const allDay = serializeICalendarEvent({
      uid: 'all-day-demo',
      summary: 'All day',
      start: '2026-10-25',
      end: '2026-10-26',
      all_day: true,
    });
    expect(allDay).toContain('DTSTART;VALUE=DATE:20261025');
    expect(allDay).toContain('DTEND;VALUE=DATE:20261026');
  });

  it('converts a New York wall time through the DST boundary', () => {
    expect(zonedWallToUtc({ year: 2026, month: 3, day: 15, hour: 9, minute: 0, second: 0 }, 'America/New_York').toISOString()).toBe(
      '2026-03-15T13:00:00.000Z',
    );
  });
});
