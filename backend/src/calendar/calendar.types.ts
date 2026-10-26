export const DEFAULT_CALENDAR_TIMEZONE = 'America/New_York';

export interface CalendarCredential {
  username: string;
  password: string;
}

export interface CalendarCredentialMailbox {
  id: string;
  emailAddress: string;
  provider: string;
  ownerKind: string;
  ownerKey: string | null;
}

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

export interface CalendarEventInput {
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

export interface CalendarEventView {
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

export interface CalendarRange {
  start: string;
  end: string;
}

export interface CalendarBusyInterval {
  start: string;
  end: string;
  type?: string | null;
}

export interface CalendarFindFreeTimeInput extends CalendarRange {
  mailbox_id: string;
  calendar_id: string;
  duration_minutes: number;
  timezone?: string | null;
  workday_start?: string;
  workday_end?: string;
  limit?: number;
}

export interface CalendarDraftPayload {
  type: 'calendar_event_draft';
  operation: 'create' | 'update' | 'cancel';
  mailbox_id: string;
  calendar_id: string;
  event_id?: string;
  etag?: string | null;
  event?: CalendarEventInput;
}
