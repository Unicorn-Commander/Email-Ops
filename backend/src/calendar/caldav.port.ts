import { CalendarBusyInterval, CalendarCredential, CalendarView } from './calendar.types';

export interface CalDavRemoteEvent {
  href: string;
  etag: string | null;
  data: string;
}

export interface CalDavWriteResult {
  href: string;
  etag: string | null;
}

export abstract class CalDavPort {
  abstract listCalendars(
    credential: CalendarCredential,
    mailboxEmail: string,
    mailboxId: string,
  ): Promise<CalendarView[]>;

  abstract listEvents(
    credential: CalendarCredential,
    calendarHref: string,
    start: Date,
    end: Date,
  ): Promise<CalDavRemoteEvent[]>;

  abstract freeBusy(
    credential: CalendarCredential,
    calendarHref: string,
    start: Date,
    end: Date,
  ): Promise<CalendarBusyInterval[]>;

  abstract createEvent(
    credential: CalendarCredential,
    calendarHref: string,
    uid: string,
    data: string,
  ): Promise<CalDavWriteResult>;

  abstract updateEvent(
    credential: CalendarCredential,
    eventHref: string,
    data: string,
    etag?: string | null,
  ): Promise<CalDavWriteResult>;

  abstract deleteEvent(
    credential: CalendarCredential,
    eventHref: string,
    etag?: string | null,
  ): Promise<void>;
}
