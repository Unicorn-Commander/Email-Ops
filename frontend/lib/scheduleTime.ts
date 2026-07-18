/**
 * Shared time presets for the two "pick a future time" surfaces — snoozing a
 * thread (reader) and scheduling a send (composer). One source of truth so the
 * weekend / cross-midnight edge handling can't drift between them.
 *
 * The set is deliberately small and human ("Later today", "Tomorrow", …), each
 * anchored to a sensible hour, filtered to strictly-future times and returned in
 * chronological order so a menu never lists a later time above an earlier one.
 */

export interface SchedulePreset {
  label: string;
  at: Date;
}

export function schedulePresets(now: Date = new Date()): SchedulePreset[] {
  const atHour = (base: Date, h: number) => {
    const d = new Date(base);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  const addDays = (base: Date, n: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
  };
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const dow = now.getDay(); // 0 Sun … 6 Sat
  const isWeekend = dow === 0 || dow === 6;
  const daysToSat = (6 - dow + 7) % 7 || 7;
  const daysToMon = (1 - dow + 7) % 7 || 7;

  const laterToday = new Date(now.getTime() + 3 * 3600 * 1000);
  const out: SchedulePreset[] = [];
  // "Later today" only while it's still today — after ~9pm, now+3h crosses
  // midnight and "today" would be a lie.
  if (sameDay(laterToday, now)) out.push({ label: 'Later today', at: laterToday });
  out.push({ label: 'Tomorrow', at: atHour(addDays(now, 1), 9) });
  // "This weekend" only Mon–Fri; on Sat/Sun you're already in it, and
  // (6-dow)%7||7 would resolve to NEXT Saturday (a week out) — confusing, so drop it.
  if (!isWeekend) out.push({ label: 'This weekend', at: atHour(addDays(now, daysToSat), 9) });
  out.push({ label: 'Next week', at: atHour(addDays(now, daysToMon), 9) });

  return out
    .filter((p) => p.at.getTime() > now.getTime() + 60_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Terse relative-ish stamp for a preset row (e.g. "Mon 9:00 AM"). */
export function formatScheduleWhen(d: Date): string {
  return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/**
 * Absolute stamp for management rows (e.g. "Mon, Jul 21, 9:00 AM"), with the
 * year only when it differs from now. Returns null for an unparseable ISO.
 */
export function formatScheduleAbsolute(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * Format a Date as the value a `<input type="datetime-local">` expects
 * (`YYYY-MM-DDTHH:mm` in LOCAL time — never via toISOString, which is UTC and
 * would shift the wall-clock the user sees). Used to seed the custom picker.
 */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
