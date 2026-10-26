import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

export interface CalendarView {
  id: string;
  mailbox_id: string;
  href: string;
  display_name: string;
  color: string | null;
  timezone: string;
  ctag: string | null;
}

export interface CalendarAttendee {
  address: string;
  name: string | null;
  role: string | null;
  status: string | null;
}

export interface CalendarEvent {
  id: string;
  uid: string;
  href?: string;
  etag?: string | null;
  mailbox_id: string;
  calendar_id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string;
  display_start: string;
  display_end: string;
  timezone: string;
  all_day: boolean;
  recurrence_rule: string | null;
  attendees: CalendarAttendee[];
  organizer: string | null;
  status: string | null;
  url: string | null;
}

export interface CalendarEventInput {
  mailbox_id: string;
  calendar_id: string;
  uid?: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  start: string;
  end: string;
  all_day?: boolean;
  timezone?: string | null;
  recurrence_rule?: string | null;
  attendees?: string[];
  organizer?: string | null;
  status?: string | null;
  url?: string | null;
}

export interface CalendarDevice {
  id: string;
  mailbox_id: string;
  label: string;
  davis_app_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface CalendarDeviceSecret extends CalendarDevice {
  server_url: string;
  username: string;
  secret: string;
}

const base = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}/calendar`;

function query(values: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

export async function listCalendars(
  workspaceId: string,
  mailboxId: string,
): Promise<{ items: CalendarView[]; count: number }> {
  return apiGet(`${base(workspaceId)}/calendars?${query({ mailbox_id: mailboxId })}`);
}

export async function listEvents(
  workspaceId: string,
  args: { mailboxId: string; calendarId: string; start: string; end: string; timezone?: string },
): Promise<{ items: CalendarEvent[]; count: number }> {
  return apiGet(
    `${base(workspaceId)}/events?${query({
      mailbox_id: args.mailboxId,
      calendar_id: args.calendarId,
      start: args.start,
      end: args.end,
      timezone: args.timezone,
    })}`,
  );
}

export async function createEvent(
  workspaceId: string,
  body: CalendarEventInput,
): Promise<CalendarEvent> {
  return apiPost(`${base(workspaceId)}/events`, body);
}

export async function updateEvent(
  workspaceId: string,
  eventId: string,
  body: CalendarEventInput & { etag?: string | null },
): Promise<CalendarEvent> {
  return apiPatch(`${base(workspaceId)}/events/${encodeURIComponent(eventId)}`, body);
}

export async function deleteEvent(
  workspaceId: string,
  event: { eventId: string; mailboxId: string; calendarId: string; etag?: string | null },
): Promise<{ deleted: boolean }> {
  return apiDelete(
    `${base(workspaceId)}/events/${encodeURIComponent(event.eventId)}?${query({
      mailbox_id: event.mailboxId,
      calendar_id: event.calendarId,
      etag: event.etag,
    })}`,
  );
}

export async function listCalendarDevices(
  workspaceId: string,
  mailboxId: string,
): Promise<{ items: CalendarDevice[]; count: number }> {
  return apiGet(`${base(workspaceId)}/devices?${query({ mailboxId })}`);
}

export async function createCalendarDevice(
  workspaceId: string,
  body: { mailboxId: string; label: string },
): Promise<CalendarDeviceSecret> {
  const idempotencyKey = `calendar-device-${randomId()}`;
  return apiPost(`${base(workspaceId)}/devices`, body, undefined, { 'Idempotency-Key': idempotencyKey });
}

export async function revokeCalendarDevice(
  workspaceId: string,
  id: string,
): Promise<{ device: CalendarDevice; confirmed: boolean }> {
  return apiDelete(`${base(workspaceId)}/devices/${encodeURIComponent(id)}`);
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
