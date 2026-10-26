import {
  CalendarAttendee,
  CalendarEventInput,
  CalendarEventView,
  DEFAULT_CALENDAR_TIMEZONE,
} from './calendar.types';

interface IcalProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface ParsedDate {
  date: Date;
  wall: WallTime;
  allDay: boolean;
  timezone: string;
  dateKey: string;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_INDEX = new Map(DAY_CODES.map((day, index) => [day, index]));

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function splitUnescaped(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\') {
      current += char;
      escaped = true;
    } else if (char === delimiter) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\,;Nn])/g, (_match, escaped: string) => {
    if (escaped.toLowerCase() === 'n') return '\n';
    return escaped;
  });
}

function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
}

function xmlSafeParam(value: string): string {
  return value.replace(/[\r\n;,]/g, ' ').trim();
}

function parseProperty(line: string): IcalProperty | null {
  const colon = line.indexOf(':');
  if (colon < 1) return null;
  const left = line.slice(0, colon).split(';');
  const name = left.shift()?.toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const parameter of left) {
    const equals = parameter.indexOf('=');
    if (equals < 1) continue;
    params[parameter.slice(0, equals).toUpperCase()] = parameter.slice(equals + 1);
  }
  return { name, params, value: line.slice(colon + 1) };
}

function unfold(data: string): string[] {
  return data
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function propertiesForEvents(data: string): IcalProperty[][] {
  const events: IcalProperty[][] = [];
  let current: IcalProperty[] | null = null;
  for (const line of unfold(data)) {
    const upper = line.toUpperCase();
    if (upper === 'BEGIN:VEVENT') {
      current = [];
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (current) {
      const property = parseProperty(line);
      if (property) current.push(property);
    }
  }
  return events;
}

function first(properties: IcalProperty[], name: string): IcalProperty | undefined {
  return properties.find((property) => property.name === name);
}

function all(properties: IcalProperty[], name: string): IcalProperty[] {
  return properties.filter((property) => property.name === name);
}

function wallFromValue(value: string): WallTime | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
  };
}

function dateKey(wall: WallTime): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

function wallAsUtc(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

function partsForTimezone(date: Date, timezone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.get('year')),
    month: Number(values.get('month')),
    day: Number(values.get('day')),
    hour: Number(values.get('hour')),
    minute: Number(values.get('minute')),
    second: Number(values.get('second')),
  };
}

/** Convert a wall-clock time in a named IANA zone to a UTC Date. */
export function zonedWallToUtc(wall: WallTime, timezone: string): Date {
  let guess = wallAsUtc(wall);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsForTimezone(new Date(guess), timezone);
    const offset = wallAsUtc(actual) - guess;
    const next = wallAsUtc(wall) - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function addWallDays(wall: WallTime, days: number): WallTime {
  const date = new Date(wallAsUtc(wall));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
    second: wall.second,
  };
}

function dayDifference(from: WallTime, to: WallTime): number {
  const fromDate = new Date(Date.UTC(from.year, from.month - 1, from.day));
  const toDate = new Date(Date.UTC(to.year, to.month - 1, to.day));
  return Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000);
}

function parseCalendarDate(property: IcalProperty, fallbackTimezone: string): ParsedDate | null {
  const wall = wallFromValue(property.value.replace(/Z$/, ''));
  if (!wall) return null;
  const allDay = property.params.VALUE?.toUpperCase() === 'DATE' || /^\d{8}$/.test(property.value);
  const timezone = property.params.TZID ?? (property.value.endsWith('Z') ? 'UTC' : fallbackTimezone);
  const date = allDay
    ? new Date(Date.UTC(wall.year, wall.month - 1, wall.day))
    : property.value.endsWith('Z')
      ? new Date(wallAsUtc(wall))
      : zonedWallToUtc(wall, timezone);
  return { date, wall, allDay, timezone, dateKey: dateKey(wall) };
}

function parseDuration(value: string): number | null {
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return null;
  return (
    (Number(match[1] ?? 0) * 86_400 +
      Number(match[2] ?? 0) * 3_600 +
      Number(match[3] ?? 0) * 60 +
      Number(match[4] ?? 0)) *
    1000
  );
}

interface RecurrenceRule {
  frequency: 'DAILY' | 'WEEKLY';
  interval: number;
  count: number | null;
  until: Date | null;
  byDay: number[];
  byMonthDay: number[];
}

function parseUntil(value: string, timezone: string): Date | null {
  const wall = wallFromValue(value.replace(/Z$/, ''));
  if (!wall) return null;
  if (/^\d{8}$/.test(value)) return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, 23, 59, 59));
  return value.endsWith('Z') ? new Date(wallAsUtc(wall)) : zonedWallToUtc(wall, timezone);
}

function parseRule(value: string, timezone: string): RecurrenceRule | null {
  const fields = new Map<string, string>();
  for (const part of value.split(';')) {
    const equals = part.indexOf('=');
    if (equals > 0) fields.set(part.slice(0, equals).toUpperCase(), part.slice(equals + 1));
  }
  const frequency = fields.get('FREQ');
  if (frequency !== 'DAILY' && frequency !== 'WEEKLY') return null;
  const byDay = (fields.get('BYDAY') ?? '')
    .split(',')
    .map((token) => DAY_INDEX.get(token.replace(/^[+-]?\d+/, '')))
    .filter((value): value is number => value !== undefined);
  const byMonthDay = (fields.get('BYMONTHDAY') ?? '')
    .split(',')
    .map(Number)
    .filter((value) => Number.isInteger(value) && value !== 0);
  return {
    frequency,
    interval: Math.max(1, Number(fields.get('INTERVAL') ?? 1) || 1),
    count: fields.has('COUNT') ? Math.max(1, Number(fields.get('COUNT')) || 1) : null,
    until: fields.has('UNTIL') ? parseUntil(fields.get('UNTIL')!, timezone) : null,
    byDay,
    byMonthDay,
  };
}

function occurrenceWalls(start: WallTime, rule: RecurrenceRule, rangeEnd: Date): WallTime[] {
  const output: WallTime[] = [];
  const maxDays = Math.min(20_000, Math.max(370, dayDifference(start, partsForTimezone(rangeEnd, 'UTC')) + 14));
  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset += 1) {
    const candidate = addWallDays(start, dayOffset);
    const candidateDate = new Date(wallAsUtc(candidate));
    if (candidateDate.getTime() > rangeEnd.getTime() + 370 * 86_400_000) break;
    const dayOfWeek = new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day)).getUTCDay();
    const weekOffset = Math.floor(dayOffset / 7);
    const inFrequency =
      rule.frequency === 'DAILY'
        ? dayOffset % rule.interval === 0
        : weekOffset % rule.interval === 0 &&
          (rule.byDay.length === 0 ? dayOfWeek === new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay() : rule.byDay.includes(dayOfWeek));
    const inMonth = rule.byMonthDay.length === 0 || rule.byMonthDay.includes(candidate.day);
    if (inFrequency && inMonth) output.push(candidate);
    if (rule.count !== null && output.length >= rule.count) break;
  }
  return output;
}

function occurrenceDates(start: ParsedDate, rule: RecurrenceRule | null, rangeEnd: Date): ParsedDate[] {
  if (!rule) return [start];
  const walls = occurrenceWalls(start.wall, rule, rangeEnd);
  return walls
    .map((wall) => ({
      date: start.allDay
        ? new Date(Date.UTC(wall.year, wall.month - 1, wall.day))
        : zonedWallToUtc(wall, start.timezone),
      wall,
      allDay: start.allDay,
      timezone: start.timezone,
      dateKey: dateKey(wall),
    }))
    .filter((candidate) => !rule.until || candidate.date.getTime() <= rule.until.getTime());
}

function displayDate(date: Date, timezone: string, allDay: boolean): string {
  if (allDay) return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'medium' }).format(date);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function attendeeFromProperty(property: IcalProperty): CalendarAttendee {
  const address = unescapeText(property.value).replace(/^mailto:/i, '');
  return {
    address,
    name: property.params.CN ? unescapeText(property.params.CN) : null,
    role: property.params.ROLE ?? null,
    status: property.params.PARTSTAT ?? null,
  };
}

function dateToken(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function dateTimeToken(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function inputDate(value: string, allDay: boolean): Date {
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid calendar date: ${value}`);
  return date;
}

function line(name: string, value: string, params?: Record<string, string>): string {
  const suffix = params
    ? Object.entries(params)
        .map(([key, item]) => `;${key}=${xmlSafeParam(item)}`)
        .join('')
    : '';
  return `${name}${suffix}:${value}`;
}

function foldLines(lines: string[]): string {
  return lines
    .flatMap((value) => {
      if (value.length <= 75) return [value];
      const pieces: string[] = [];
      for (let index = 0; index < value.length; index += 74) {
        pieces.push(`${index ? ' ' : ''}${value.slice(index, index + 74)}`);
      }
      return pieces;
    })
    .join('\r\n');
}

/** Parse and expand VEVENTs intersecting the supplied UTC range. */
export function parseICalendarEvents(
  data: string,
  rangeStart: Date,
  rangeEnd: Date,
  displayTimezone = DEFAULT_CALENDAR_TIMEZONE,
): Array<Omit<CalendarEventView, 'mailbox_id' | 'calendar_id'>> {
  const views: Array<Omit<CalendarEventView, 'mailbox_id' | 'calendar_id'>> = [];
  for (const properties of propertiesForEvents(data)) {
    const startProperty = first(properties, 'DTSTART');
    if (!startProperty) continue;
    const start = parseCalendarDate(startProperty, displayTimezone);
    if (!start) continue;
    const endProperty = first(properties, 'DTEND');
    const duration = first(properties, 'DURATION') ? parseDuration(first(properties, 'DURATION')!.value) : null;
    const end = endProperty
      ? parseCalendarDate(endProperty, start.timezone)
      : {
          date: new Date(start.date.getTime() + (duration ?? (start.allDay ? 86_400_000 : 3_600_000))),
          wall: addWallDays(start.wall, start.allDay ? 1 : 0),
          allDay: start.allDay,
          timezone: start.timezone,
          dateKey: dateKey(start.wall),
        };
    if (!end) continue;
    const durationMs = end.date.getTime() - start.date.getTime();
    const ruleProperty = first(properties, 'RRULE');
    const rule = ruleProperty ? parseRule(ruleProperty.value, start.timezone) : null;
    const exdates = all(properties, 'EXDATE').flatMap((property) =>
      property.value.split(',').map((value) => parseCalendarDate({ ...property, value }, start.timezone)?.date.getTime()),
    );
    const uid = unescapeText(first(properties, 'UID')?.value ?? `event-${start.date.getTime()}`);
    const summary = unescapeText(first(properties, 'SUMMARY')?.value ?? '(untitled)');
    const description = first(properties, 'DESCRIPTION') ? unescapeText(first(properties, 'DESCRIPTION')!.value) : null;
    const location = first(properties, 'LOCATION') ? unescapeText(first(properties, 'LOCATION')!.value) : null;
    const organizer = first(properties, 'ORGANIZER')?.value.replace(/^mailto:/i, '') ?? null;
    const status = first(properties, 'STATUS')?.value ?? null;
    const url = first(properties, 'URL')?.value ?? null;
    const attendees = all(properties, 'ATTENDEE').map(attendeeFromProperty);
    for (const occurrence of occurrenceDates(start, rule, rangeEnd)) {
      const occurrenceEnd = new Date(occurrence.date.getTime() + durationMs);
      if (exdates.some((excluded) => excluded === occurrence.date.getTime())) continue;
      if (occurrenceEnd <= rangeStart || occurrence.date >= rangeEnd) continue;
      views.push({
        id: rule ? `${uid}:${occurrence.date.toISOString()}` : uid,
        uid,
        etag: null,
        summary,
        description,
        location,
        start: occurrence.date.toISOString(),
        end: occurrenceEnd.toISOString(),
        display_start: displayDate(occurrence.date, displayTimezone, occurrence.allDay),
        display_end: displayDate(occurrenceEnd, displayTimezone, occurrence.allDay),
        timezone: occurrence.timezone || displayTimezone,
        all_day: occurrence.allDay,
        recurrence_rule: ruleProperty?.value ?? null,
        attendees,
        organizer,
        status,
        url,
      });
    }
  }
  return views.sort((left, right) => left.start.localeCompare(right.start));
}

/** Serialize one event into the UTC VEVENT form accepted by Davis. */
export function serializeICalendarEvent(input: CalendarEventInput): string {
  const uid = input.uid ?? `event-${Date.now()}@email-ops`;
  const allDay = input.all_day === true;
  const start = inputDate(input.start, allDay);
  const end = inputDate(input.end, allDay);
  if (end.getTime() <= start.getTime()) throw new Error('Calendar event end must be after start.');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Unicorn Commander//Email-Ops//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    line('UID', escapeText(uid)),
    line('DTSTAMP', dateTimeToken(new Date())),
    allDay
      ? line('DTSTART', dateToken(start), { VALUE: 'DATE' })
      : line('DTSTART', dateTimeToken(start)),
    allDay
      ? line('DTEND', dateToken(end), { VALUE: 'DATE' })
      : line('DTEND', dateTimeToken(end)),
    line('SUMMARY', escapeText(input.summary.trim())),
  ];
  if (input.description) lines.push(line('DESCRIPTION', escapeText(input.description)));
  if (input.location) lines.push(line('LOCATION', escapeText(input.location)));
  if (input.recurrence_rule) lines.push(line('RRULE', input.recurrence_rule));
  if (input.organizer) lines.push(line('ORGANIZER', `mailto:${escapeText(input.organizer)}`));
  if (input.status) lines.push(line('STATUS', input.status));
  if (input.url) lines.push(line('URL', escapeText(input.url)));
  for (const attendee of input.attendees ?? []) {
    lines.push(line('ATTENDEE', `mailto:${escapeText(attendee)}`));
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${foldLines(lines)}\r\n`;
}
