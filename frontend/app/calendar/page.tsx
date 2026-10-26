'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Input,
  Select,
  Skeleton,
  cn,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { listMailboxes, type MailboxView } from '@/lib/mailboxApi';
import {
  createEvent,
  deleteEvent,
  listCalendars,
  listEvents,
  updateEvent,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarView,
} from '@/lib/calendarApi';
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  PlusIcon,
  RefreshIcon,
} from '@/components/mail/icons';

type CalendarMode = 'month' | 'week' | 'day' | 'agenda';
type LoadState = 'loading' | 'ready' | 'error' | 'empty';

const DISPLAY_TIMEZONE = 'America/New_York';
const DEMO_MAILBOX_ID = 'demo-mailbox';
const DEMO_CALENDAR_ID = 'demo-calendar';

const DEMO_CALENDAR: CalendarView = {
  id: DEMO_CALENDAR_ID,
  mailbox_id: DEMO_MAILBOX_ID,
  href: 'demo://calendar',
  display_name: 'Demo calendar',
  color: '#7c5cff',
  timezone: DISPLAY_TIMEZONE,
  ctag: 'demo',
};

function demoEvent(
  id: string,
  summary: string,
  start: string,
  end: string,
  options: Partial<CalendarEvent> = {},
): CalendarEvent {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return {
    id,
    uid: id,
    mailbox_id: DEMO_MAILBOX_ID,
    calendar_id: DEMO_CALENDAR_ID,
    summary,
    description: null,
    location: null,
    start,
    end,
    display_start: formatDateTime(startDate),
    display_end: formatDateTime(endDate),
    timezone: DISPLAY_TIMEZONE,
    all_day: false,
    recurrence_rule: null,
    attendees: [],
    organizer: null,
    status: null,
    url: null,
    ...options,
  };
}

const DEMO_EVENTS: CalendarEvent[] = [
  demoEvent('demo-focus', 'Focus block', '2026-10-26T14:00:00.000Z', '2026-10-26T15:00:00.000Z', {
    location: 'Quiet room',
  }),
  demoEvent('demo-review', 'Project review', '2026-10-27T18:30:00.000Z', '2026-10-27T19:15:00.000Z', {
    location: 'Video room',
  }),
  demoEvent('demo-all-day', 'Planning day', '2026-10-29T00:00:00.000Z', '2026-10-30T00:00:00.000Z', {
    all_day: true,
    display_start: 'Oct 29, 2026',
    display_end: 'Oct 30, 2026',
  }),
];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIMEZONE, weekday: 'short' }).format(date);
}

function formatDayNumber(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIMEZONE, day: 'numeric' }).format(date);
}

function formatMonth(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIMEZONE, month: 'long', year: 'numeric' }).format(date);
}

function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const day = result.getDay();
  result.setDate(result.getDate() - (day === 0 ? 6 : day - 1));
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function rangeFor(mode: CalendarMode, cursor: Date): { start: Date; end: Date } {
  if (mode === 'day') {
    const start = new Date(cursor);
    start.setHours(0, 0, 0, 0);
    return { start, end: addDays(start, 1) };
  }
  if (mode === 'week') {
    const start = startOfWeek(cursor);
    return { start, end: addDays(start, 7) };
  }
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  return { start, end: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1) };
}

function gridDays(cursor: Date): Date[] {
  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const first = startOfWeek(monthStart);
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

function localInput(date: string, allDay: boolean): string {
  if (allDay) return date.slice(0, 10);
  const value = new Date(date);
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function defaultForm(): EventForm {
  const start = new Date();
  start.setMinutes(Math.ceil(start.getMinutes() / 30) * 30, 0, 0);
  return {
    summary: '',
    start: localInput(start.toISOString(), false),
    end: localInput(new Date(start.getTime() + 3_600_000).toISOString(), false),
    all_day: false,
    timezone: DISPLAY_TIMEZONE,
    description: '',
    location: '',
    attendees: '',
    etag: null,
  };
}

interface EventForm {
  id?: string;
  uid?: string;
  summary: string;
  start: string;
  end: string;
  all_day: boolean;
  timezone: string;
  description: string;
  location: string;
  attendees: string;
  etag: string | null;
}

function eventForm(event: CalendarEvent): EventForm {
  return {
    id: event.id,
    uid: event.uid,
    summary: event.summary,
    start: localInput(event.start, event.all_day),
    end: localInput(event.end, event.all_day),
    all_day: event.all_day,
    timezone: event.timezone || DISPLAY_TIMEZONE,
    description: event.description ?? '',
    location: event.location ?? '',
    attendees: event.attendees.map((attendee) => attendee.address).join(', '),
    etag: event.etag ?? null,
  };
}

function eventInput(form: EventForm, mailboxId: string, calendarId: string): CalendarEventInput {
  const attendees = form.attendees
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    mailbox_id: mailboxId,
    calendar_id: calendarId,
    uid: form.uid,
    summary: form.summary.trim(),
    start: form.all_day ? form.start : new Date(form.start).toISOString(),
    end: form.all_day ? form.end : new Date(form.end).toISOString(),
    all_day: form.all_day,
    timezone: form.timezone || DISPLAY_TIMEZONE,
    description: form.description.trim() || null,
    location: form.location.trim() || null,
    attendees,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export default function CalendarPage() {
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;
  const [mode, setMode] = useState<CalendarMode>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [mailboxes, setMailboxes] = useState<MailboxView[]>([]);
  const [mailboxId, setMailboxId] = useState('');
  const [calendars, setCalendars] = useState<CalendarView[]>([]);
  const [calendarId, setCalendarId] = useState('');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [editor, setEditor] = useState<EventForm | null>(null);
  const [saving, setSaving] = useState(false);

  const range = useMemo(() => rangeFor(mode, cursor), [mode, cursor]);
  const visibleDays = useMemo(
    () => (mode === 'month' ? gridDays(cursor) : mode === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i)) : [cursor]),
    [mode, cursor],
  );

  const loadResources = useCallback(async () => {
    if (!workspaceId) return;
    setLoad('loading');
    setError(null);
    setDemoMode(false);
    try {
      const mailboxResult = await listMailboxes(workspaceId);
      const available = mailboxResult.items.filter(
        (mailbox) => mailbox.active && ['james', 'stalwart'].includes((mailbox.provider ?? 'stalwart').toLowerCase()),
      );
      setMailboxes(available);
      const selected = available.find((mailbox) => mailbox.id === mailboxId) ?? available.find((mailbox) => mailbox.is_default) ?? available[0];
      if (!selected) throw new Error('No Davis-backed mailbox is available in this workspace.');
      setMailboxId(selected.id);
      const calendarResult = await listCalendars(workspaceId, selected.id);
      setCalendars(calendarResult.items);
      setCalendarId((current) => calendarResult.items.some((item) => item.id === current) ? current : calendarResult.items[0]?.id ?? '');
      setLoad(calendarResult.items.length ? 'ready' : 'empty');
    } catch (loadError) {
      if (process.env.NODE_ENV !== 'production') {
        setDemoMode(true);
        setMailboxes([]);
        setCalendars([DEMO_CALENDAR]);
        setMailboxId(DEMO_MAILBOX_ID);
        setCalendarId(DEMO_CALENDAR_ID);
        setEvents(DEMO_EVENTS);
        setLoad('ready');
        setError('Davis is not reachable in this development environment; fictional demo fixtures are shown.');
      } else {
        setLoad('error');
        setError(errorMessage(loadError, 'Could not load the calendar.'));
      }
    }
  }, [workspaceId, mailboxId]);

  useEffect(() => {
    if (!workspaceId) {
      if (workspaceLoad !== 'loading') setLoad('empty');
      return;
    }
    void loadResources();
  }, [workspaceId, workspaceLoad, loadResources]);

  useEffect(() => {
    if (!workspaceId || !calendarId || demoMode) return;
    let alive = true;
    setLoad('loading');
    void listEvents(workspaceId, {
      mailboxId,
      calendarId,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      timezone: DISPLAY_TIMEZONE,
    })
      .then((result) => {
        if (!alive) return;
        setEvents(result.items);
        setLoad(result.items.length ? 'ready' : 'empty');
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!alive) return;
        if (process.env.NODE_ENV !== 'production') {
          setDemoMode(true);
          setEvents(DEMO_EVENTS);
          setLoad('ready');
          setError('Davis is not reachable in this development environment; fictional demo fixtures are shown.');
        } else {
          setLoad('error');
          setError(errorMessage(loadError, 'Could not load events.'));
        }
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, mailboxId, calendarId, range.start, range.end, demoMode]);

  const refresh = () => void loadResources();
  const shift = (amount: number) => {
    setCursor((current) => {
      const next = new Date(current);
      if (mode === 'day') next.setDate(next.getDate() + amount);
      else if (mode === 'week') next.setDate(next.getDate() + amount * 7);
      else next.setMonth(next.getMonth() + amount);
      return next;
    });
  };

  const eventsForDay = useCallback(
    (day: Date) => events.filter((event) => dateKey(new Date(event.start)) === dateKey(day)),
    [events],
  );

  const openCreate = (day?: Date) => {
    const form = defaultForm();
    if (day) {
      const start = new Date(day);
      start.setHours(9, 0, 0, 0);
      form.start = localInput(start.toISOString(), false);
      form.end = localInput(new Date(start.getTime() + 3_600_000).toISOString(), false);
    }
    setEditor(form);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || !editor.summary.trim()) return;
    const targetMailbox = mailboxId || DEMO_MAILBOX_ID;
    const targetCalendar = calendarId || DEMO_CALENDAR_ID;
    const input = eventInput(editor, targetMailbox, targetCalendar);
    setSaving(true);
    setError(null);
    try {
      if (demoMode) {
        const start = input.all_day ? `${input.start}T00:00:00.000Z` : input.start;
        const end = input.all_day ? `${input.end}T00:00:00.000Z` : input.end;
        const next = demoEvent(editor.id ?? `demo-${Date.now()}`, input.summary, start, end, {
          all_day: input.all_day,
          location: input.location ?? null,
          description: input.description ?? null,
          attendees: (input.attendees ?? []).map((address) => ({ address, name: null, role: null, status: null })),
          display_start: input.all_day ? input.start : formatDateTime(new Date(start)),
          display_end: input.all_day ? input.end : formatDateTime(new Date(end)),
        });
        setEvents((current) => editor.id ? current.map((item) => item.id === editor.id ? next : item) : [...current, next]);
      } else if (workspaceId && editor.id) {
        const saved = await updateEvent(workspaceId, editor.id, { ...input, etag: editor.etag });
        setEvents((current) => current.map((item) => item.id === editor.id ? saved : item));
      } else if (workspaceId) {
        const created = await createEvent(workspaceId, input);
        setEvents((current) => [...current, created]);
      }
      setEditor(null);
      setLoad('ready');
    } catch (saveError) {
      setError(errorMessage(saveError, 'Could not save the event.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editor?.id) return;
    if (typeof window !== 'undefined' && !window.confirm('Cancel this event?')) return;
    setSaving(true);
    try {
      if (demoMode) {
        setEvents((current) => current.filter((item) => item.id !== editor.id));
      } else if (workspaceId) {
        await deleteEvent(workspaceId, {
          eventId: editor.id,
          mailboxId,
          calendarId,
          etag: editor.etag,
        });
        setEvents((current) => current.filter((item) => item.id !== editor.id));
      }
      setEditor(null);
    } catch (deleteError) {
      setError(errorMessage(deleteError, 'Could not cancel the event.'));
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'agenda' ? 'Agenda' : mode === 'day' ? formatDateTime(cursor).split(' at ')[0] : mode === 'week' ? `Week of ${formatDateTime(visibleDays[0]).split(' at ')[0]}` : formatMonth(cursor);
  const selectedCalendar = calendars.find((calendar) => calendar.id === calendarId) ?? null;

  return (
    <div className="space-y-5 pb-8">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="accent" dot>Calendar</Badge>
            {demoMode && <Badge variant="warning">Fictional demo fixtures</Badge>}
            {selectedCalendar && <Badge variant="protected">{selectedCalendar.display_name}</Badge>}
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-primary">Your calendar</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">
            Day, week, month, and agenda views for the Davis calendar attached to your workspace mailbox.
            Times display in {DISPLAY_TIMEZONE} and are stored as UTC.
          </p>
          {error && <p role="status" className="mt-3 text-sm text-warning">{error}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={refresh} leading={<RefreshIcon className="h-4 w-4" />}>
            Refresh
          </Button>
          <Button size="sm" onClick={() => openCreate()} leading={<PlusIcon className="h-4 w-4" />}>
            New event
          </Button>
        </div>
      </header>

      {!activeWorkspace && workspaceLoad !== 'loading' ? (
        <Card padded>
          <p className="text-sm font-medium text-primary">No active workspace</p>
          <p className="mt-1 text-sm text-tertiary">Choose or create a workspace before opening its calendar.</p>
        </Card>
      ) : load === 'loading' ? (
        <CalendarSkeleton />
      ) : load === 'error' ? (
        <Card padded>
          <p className="text-sm font-medium text-danger">Calendar unavailable</p>
          <p className="mt-1 text-sm text-tertiary">{error ?? 'The calendar could not be loaded.'}</p>
          <Button className="mt-4" variant="secondary" onClick={refresh}>Try again</Button>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-subtle p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setCursor(new Date())}>Today</Button>
                <button type="button" aria-label="Previous period" className="grid h-9 w-9 place-items-center rounded-token text-tertiary hover:bg-surface-overlay hover:text-primary" onClick={() => shift(-1)}><ChevronLeftIcon className="h-4 w-4" /></button>
                <button type="button" aria-label="Next period" className="grid h-9 w-9 place-items-center rounded-token text-tertiary hover:bg-surface-overlay hover:text-primary" onClick={() => shift(1)}><ChevronRightIcon className="h-4 w-4" /></button>
                <h2 className="ml-1 text-sm font-semibold text-primary sm:text-base">{title}</h2>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {mailboxes.length > 1 && <Select aria-label="Mailbox" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)} className="max-w-[180px]"><option value="">Mailbox</option>{mailboxes.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.email_address}</option>)}</Select>}
                {calendars.length > 1 && <Select aria-label="Calendar" value={calendarId} onChange={(event) => setCalendarId(event.target.value)} className="max-w-[170px]"><option value="">Calendar</option>{calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.display_name}</option>)}</Select>}
                <div className="flex rounded-token border border-border bg-surface-base p-0.5" role="group" aria-label="Calendar view">
                  {(['month', 'week', 'day', 'agenda'] as CalendarMode[]).map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)} className={cn('rounded-[7px] px-2.5 py-1.5 text-xs font-medium capitalize transition-colors', mode === item ? 'bg-accent/15 text-accent' : 'text-tertiary hover:text-primary')}>{item}</button>)}
                </div>
              </div>
            </div>
            {mode === 'agenda' ? (
              <Agenda events={events} onSelect={(event) => setEditor(eventForm(event))} onCreate={() => openCreate()} />
            ) : (
              <CalendarGrid mode={mode} days={visibleDays} eventsForDay={eventsForDay} cursor={cursor} onSelect={(event) => setEditor(eventForm(event))} onCreate={openCreate} />
            )}
          </Card>
          {load === 'empty' && <p className="text-center text-sm text-muted" role="status">No events in this range. Select a day or create the first event.</p>}
        </>
      )}

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => { if (!open && !saving) setEditor(null); }}
        title={editor?.id ? 'Edit event' : 'Create event'}
        description="Your changes are saved to the selected Davis calendar."
        className="max-w-lg"
        footer={editor?.id ? <Button variant="danger" size="sm" onClick={() => void remove()} disabled={saving}>Cancel event</Button> : undefined}
      >
        {editor && <EventEditor form={editor} setForm={setEditor} onClose={() => setEditor(null)} onSubmit={save} saving={saving} />}
      </Dialog>
    </div>
  );
}

function CalendarSkeleton() {
  return <div className="grid gap-4 lg:grid-cols-7"><Skeleton h={72} className="lg:col-span-7" />{Array.from({ length: 14 }, (_, index) => <Skeleton key={index} h={96} />)}</div>;
}

function CalendarGrid({
  mode,
  days,
  cursor,
  eventsForDay,
  onSelect,
  onCreate,
}: {
  mode: Exclude<CalendarMode, 'agenda'>;
  days: Date[];
  cursor: Date;
  eventsForDay: (day: Date) => CalendarEvent[];
  onSelect: (event: CalendarEvent) => void;
  onCreate: (day?: Date) => void;
}) {
  const columns = mode === 'day' ? 'grid-cols-1' : 'grid-cols-7';
  return (
    <div className={cn('grid divide-x divide-y divide-subtle', columns)}>
      {mode !== 'day' && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <div key={day} className="bg-surface-base px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{day}</div>)}
      {days.map((day) => {
        const items = eventsForDay(day);
        const outsideMonth = mode === 'month' && day.getMonth() !== cursor.getMonth();
        const today = dateKey(day) === dateKey(new Date());
        return (
          <div key={day.toISOString()} className={cn('group min-h-[132px] bg-surface-raised p-2 transition-colors hover:bg-surface-overlay', mode === 'week' && 'min-h-[380px]', mode === 'day' && 'min-h-[500px]', outsideMonth && 'bg-surface-base/50')}>
            <div className="mb-2 flex items-center justify-between">
              <time dateTime={localDateKey(day)} className={cn('grid h-7 min-w-7 place-items-center rounded-full px-1 text-xs font-semibold', today ? 'bg-accent text-accent-contrast' : outsideMonth ? 'text-muted' : 'text-tertiary')}>{mode !== 'month' && <span className="mr-1">{formatDay(day)}</span>}{formatDayNumber(day)}</time>
              <button type="button" aria-label={`Add event on ${localDateKey(day)}`} onClick={() => onCreate(day)} className="grid h-7 w-7 place-items-center rounded-full text-muted opacity-0 transition-opacity hover:bg-accent/15 hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"><PlusIcon className="h-4 w-4" /></button>
            </div>
            <div className="space-y-1">
              {items.map((event) => <EventPill key={`${event.id}-${event.start}`} event={event} onClick={() => onSelect(event)} />)}
              {items.length === 0 && mode !== 'month' && <p className="pt-8 text-center text-xs text-muted">Open</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventPill({ event, onClick }: { event: CalendarEvent; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="block w-full rounded-token border border-accent/20 bg-accent/10 px-2 py-1.5 text-left text-xs text-secondary transition-colors hover:border-accent/50 hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-accent/60"><span className="block truncate font-medium text-primary">{event.summary}</span><span className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-tertiary">{event.all_day ? 'All day' : <><ClockIcon className="h-3 w-3 shrink-0" />{new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIMEZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(event.start))}</>}</span></button>;
}

function Agenda({ events, onSelect, onCreate }: { events: CalendarEvent[]; onSelect: (event: CalendarEvent) => void; onCreate: () => void }) {
  const sorted = [...events].sort((left, right) => left.start.localeCompare(right.start));
  return <div className="p-4 sm:p-6"><div className="mb-4 flex items-center justify-between"><div><h3 className="text-sm font-semibold text-primary">Upcoming events</h3><p className="mt-1 text-xs text-muted">A chronological view of this calendar range.</p></div><Button variant="secondary" size="sm" onClick={onCreate} leading={<PlusIcon className="h-4 w-4" />}>Add</Button></div>{sorted.length === 0 ? <div className="rounded-token border border-dashed border-border p-8 text-center text-sm text-muted">Nothing scheduled here.</div> : <div className="divide-y divide-subtle">{sorted.map((event) => <button type="button" key={`${event.id}-${event.start}`} onClick={() => onSelect(event)} className="flex w-full items-start gap-4 py-4 text-left hover:bg-surface-overlay"><div className="w-24 shrink-0 text-xs text-tertiary"><span className="block font-semibold text-primary">{new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIMEZONE, month: 'short', day: 'numeric' }).format(new Date(event.start))}</span><span className="mt-1 block">{event.all_day ? 'All day' : new Intl.DateTimeFormat('en-US', { timeZone: DISPLAY_TIMEZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(event.start))}</span></div><div className="min-w-0"><p className="truncate text-sm font-medium text-primary">{event.summary}</p>{event.location && <p className="mt-1 truncate text-xs text-tertiary">{event.location}</p>}{event.description && <p className="mt-1 line-clamp-2 text-xs text-muted">{event.description}</p>}</div></button>)}</div>}</div>;
}

function EventEditor({
  form,
  setForm,
  onClose,
  onSubmit,
  saving,
}: {
  form: EventForm;
  setForm: (form: EventForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  saving: boolean;
}) {
  const update = <K extends keyof EventForm>(key: K, value: EventForm[K]) => setForm({ ...form, [key]: value });
  return <form className="space-y-4" onSubmit={onSubmit}><div><label htmlFor="calendar-summary" className="mb-1.5 block text-xs font-semibold text-tertiary">Title</label><Input id="calendar-summary" autoFocus required value={form.summary} onChange={(event) => update('summary', event.target.value)} placeholder="Team focus" /></div><div className="grid gap-3 sm:grid-cols-2"><div><label htmlFor="calendar-start" className="mb-1.5 block text-xs font-semibold text-tertiary">Starts</label><Input id="calendar-start" required type={form.all_day ? 'date' : 'datetime-local'} value={form.start} onChange={(event) => update('start', event.target.value)} /></div><div><label htmlFor="calendar-end" className="mb-1.5 block text-xs font-semibold text-tertiary">Ends</label><Input id="calendar-end" required type={form.all_day ? 'date' : 'datetime-local'} value={form.end} onChange={(event) => update('end', event.target.value)} /></div></div><label className="flex items-center gap-2 text-sm text-secondary"><input type="checkbox" checked={form.all_day} onChange={(event) => { const allDay = event.target.checked; setForm({ ...form, all_day: allDay, start: allDay ? form.start.slice(0, 10) : `${form.start.slice(0, 10)}T09:00`, end: allDay ? form.end.slice(0, 10) : `${form.end.slice(0, 10)}T10:00` }); }} />All-day event</label><div><label htmlFor="calendar-location" className="mb-1.5 block text-xs font-semibold text-tertiary">Location</label><Input id="calendar-location" value={form.location} onChange={(event) => update('location', event.target.value)} placeholder="Optional" /></div><div><label htmlFor="calendar-attendees" className="mb-1.5 block text-xs font-semibold text-tertiary">Invitees</label><Input id="calendar-attendees" value={form.attendees} onChange={(event) => update('attendees', event.target.value)} placeholder="Optional, comma-separated addresses" /><p className="mt-1 text-[11px] text-muted">Invitee notification follows the normal human/agent approval boundary.</p></div><div><label htmlFor="calendar-description" className="mb-1.5 block text-xs font-semibold text-tertiary">Notes</label><textarea id="calendar-description" rows={3} value={form.description} onChange={(event) => update('description', event.target.value)} className="block w-full rounded-token border border-border bg-surface-base px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40" placeholder="Optional notes" /></div><div className="flex justify-end gap-2 border-t border-subtle pt-4"><Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Close</Button><Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Create event'}</Button></div></form>;
}
