/** The business calendar used by Email-Ops when a record has no own zone. */
export const BUSINESS_TIME_ZONE = 'America/New_York';

export interface UtcWindow {
  /** Inclusive UTC instant at the start of the business calendar day. */
  start: Date;
  /** Exclusive UTC instant at the start of the following business day. */
  end: Date;
}

type CalendarParts = {
  year: number;
  month: number;
  day: number;
};

type ZonedParts = CalendarParts & {
  hour: number;
  minute: number;
  second: number;
};

const businessDateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function zonedParts(date: Date): ZonedParts {
  const values = Object.fromEntries(
    businessDateTimeFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
  ) as Record<string, string>;
  const hour = Number(values.hour);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function calendarParts(parts: ZonedParts): CalendarParts {
  return { year: parts.year, month: parts.month, day: parts.day };
}

function pseudoUtcMillis(parts: ZonedParts | CalendarParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    'hour' in parts ? parts.hour : 0,
    'minute' in parts ? parts.minute : 0,
    'second' in parts ? parts.second : 0,
  );
}

function nextCalendarDay(parts: CalendarParts): CalendarParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

/**
 * Convert a local calendar midnight to its UTC instant without assuming a
 * fixed offset. The small fixed-point iteration follows the IANA zone's
 * offset, including the fall-back transition.
 */
function utcMidnight(parts: CalendarParts): Date {
  const localMidnight = pseudoUtcMillis(parts);
  let candidate = localMidnight;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const localAtCandidate = zonedParts(new Date(candidate));
    const offset = pseudoUtcMillis(localAtCandidate) - candidate;
    const next = localMidnight - offset;
    if (next === candidate) return new Date(candidate);
    candidate = next;
  }

  return new Date(candidate);
}

/**
 * Return the current New York business-calendar day as a half-open UTC range.
 * The returned Dates are UTC instants suitable for Prisma comparisons.
 */
export function businessDayWindow(now: Date = new Date()): UtcWindow {
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('businessDayWindow requires a valid Date');

  const today = calendarParts(zonedParts(now));
  return {
    start: utcMidnight(today),
    end: utcMidnight(nextCalendarDay(today)),
  };
}
