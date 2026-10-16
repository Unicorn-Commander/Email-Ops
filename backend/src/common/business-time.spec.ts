import { BUSINESS_TIME_ZONE, businessDayWindow } from './business-time';

describe('business time', () => {
  it('uses the named New York business zone and half-open calendar-day bounds', () => {
    expect(BUSINESS_TIME_ZONE).toBe('America/New_York');
    expect(businessDayWindow(new Date('2026-10-17T00:30:00.000Z'))).toEqual({
      start: new Date('2026-10-16T04:00:00.000Z'),
      end: new Date('2026-10-17T04:00:00.000Z'),
    });
  });

  it('keeps the business-day boundaries correct across the 2026 fall-back', () => {
    const window = businessDayWindow(new Date('2026-11-01T06:30:00.000Z'));

    expect(window.start).toEqual(new Date('2026-11-01T04:00:00.000Z'));
    expect(window.end).toEqual(new Date('2026-11-02T05:00:00.000Z'));
    expect(window.end.getTime() - window.start.getTime()).toBe(25 * 60 * 60 * 1000);
  });
});
