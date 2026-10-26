import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AgentActionKind, AgentInboxApprovalTier, AgentInboxKind } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { assertMailboxVisible } from '../common/mailbox/mailbox-scope';
import { CalDavPort } from './caldav.port';
import { CalendarCredentialsPort } from './calendar-credentials.port';
import {
  CalendarBusyInterval,
  CalendarCredentialMailbox,
  CalendarDraftPayload,
  CalendarEventInput,
  CalendarEventView,
  CalendarFindFreeTimeInput,
  CalendarRange,
  CalendarView,
  DEFAULT_CALENDAR_TIMEZONE,
} from './calendar.types';
import { parseICalendarEvents, serializeICalendarEvent } from './icalendar';

interface VisibleMailbox extends CalendarCredentialMailbox {
  workspaceId: string;
}

interface CalendarWithMailbox {
  mailbox: VisibleMailbox;
  calendar: CalendarView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} must be an ISO date.`);
  return date;
}

function rangeDates(range: CalendarRange): { start: Date; end: Date } {
  const start = isoDate(range.start, 'start');
  const end = isoDate(range.end, 'end');
  if (end <= start) throw new BadRequestException('Calendar range end must be after start.');
  return { start, end };
}

function timeParts(value: string): { hour: number; minute: number } {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new BadRequestException('Workday times must use HH:MM.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new BadRequestException('Workday time is out of range.');
  return { hour, minute };
}

function calendarEventPayload(input: CalendarEventInput): CalendarEventInput {
  const summary = input.summary?.trim();
  if (!summary) throw new BadRequestException('Calendar event summary is required.');
  const allDay = input.all_day === true;
  const start = allDay && /^\d{4}-\d{2}-\d{2}$/.test(input.start) ? input.start : isoDate(input.start, 'start').toISOString();
  const end = allDay && /^\d{4}-\d{2}-\d{2}$/.test(input.end) ? input.end : isoDate(input.end, 'end').toISOString();
  if (new Date(end).getTime() <= new Date(start).getTime() && !allDay) {
    throw new BadRequestException('Calendar event end must be after start.');
  }
  if (allDay && end <= start) throw new BadRequestException('All-day event end date must be after start date.');
  return {
    uid: input.uid?.trim() || undefined,
    summary,
    description: input.description?.trim() || null,
    location: input.location?.trim() || null,
    start,
    end,
    all_day: allDay,
    timezone: input.timezone?.trim() || DEFAULT_CALENDAR_TIMEZONE,
    recurrence_rule: input.recurrence_rule?.trim() || null,
    attendees: (input.attendees ?? []).map((address) => address.trim()).filter(Boolean),
    organizer: input.organizer?.trim() || null,
    status: input.status?.trim() || null,
    url: input.url?.trim() || null,
  };
}

export function getCalendarDraftPayload(value: unknown): CalendarDraftPayload | null {
  if (!isRecord(value) || value.type !== 'calendar_event_draft') return null;
  if (
    (value.operation !== 'create' && value.operation !== 'update' && value.operation !== 'cancel') ||
    typeof value.mailbox_id !== 'string' ||
    typeof value.calendar_id !== 'string'
  ) {
    return null;
  }
  if (value.operation !== 'cancel' && !isRecord(value.event)) return null;
  return {
    type: 'calendar_event_draft',
    operation: value.operation,
    mailbox_id: value.mailbox_id,
    calendar_id: value.calendar_id,
    event_id: typeof value.event_id === 'string' ? value.event_id : undefined,
    etag: typeof value.etag === 'string' ? value.etag : null,
    event: value.event as unknown as CalendarEventInput | undefined,
  };
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly caldav: CalDavPort,
    private readonly credentials: CalendarCredentialsPort,
  ) {}

  private async visibleMailbox(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<VisibleMailbox | null> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await tx.mailboxAccount.findFirst({ where: { id: mailboxId, workspaceId } });
      if (!mailbox) return null;
      await assertMailboxVisible(tx, workspaceId, ucUid, mailbox);
      return {
        id: mailbox.id,
        emailAddress: mailbox.emailAddress,
        provider: mailbox.provider,
        ownerKind: mailbox.ownerKind,
        ownerKey: mailbox.ownerKey,
        workspaceId,
      };
    });
  }

  private async mailboxOrThrow(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<VisibleMailbox> {
    const mailbox = await this.visibleMailbox(workspaceId, ucUid, mailboxId);
    if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
    if (!['james', 'stalwart'].includes(mailbox.provider.toLowerCase())) {
      throw new BadRequestException('Calendar is available only for a Davis-backed mailbox.');
    }
    return mailbox;
  }

  private async credentialFor(mailbox: VisibleMailbox) {
    const credential = await this.credentials.resolve(mailbox.workspaceId, mailbox);
    if (!credential) {
      throw new ServiceUnavailableException(
        'Calendar mailbox credentials are not configured. A Davis app-key bridge is required before the calendar can connect.',
      );
    }
    return credential;
  }

  private async calendarFor(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
    calendarId: string,
  ): Promise<CalendarWithMailbox> {
    const mailbox = await this.mailboxOrThrow(workspaceId, ucUid, mailboxId);
    const credential = await this.credentialFor(mailbox);
    const calendars = await this.caldav.listCalendars(credential, mailbox.emailAddress, mailbox.id);
    const calendar = calendars.find(
      (item) => item.id === calendarId || item.href === calendarId || item.display_name === calendarId,
    );
    if (!calendar) throw new NotFoundException('Calendar not found in this mailbox.');
    return { mailbox, calendar };
  }

  async listCalendars(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<CalendarView[]> {
    const mailbox = await this.mailboxOrThrow(workspaceId, ucUid, mailboxId);
    const credential = await this.credentialFor(mailbox);
    return this.caldav.listCalendars(credential, mailbox.emailAddress, mailbox.id);
  }

  async listEvents(
    workspaceId: string,
    ucUid: string | null,
    input: CalendarRange & { mailbox_id: string; calendar_id: string; timezone?: string | null },
  ): Promise<CalendarEventView[]> {
    const { start, end } = rangeDates(input);
    const { mailbox, calendar } = await this.calendarFor(
      workspaceId,
      ucUid,
      input.mailbox_id,
      input.calendar_id,
    );
    const credential = await this.credentialFor(mailbox);
    const remoteEvents = await this.caldav.listEvents(credential, calendar.href, start, end);
    const timezone = input.timezone || calendar.timezone || DEFAULT_CALENDAR_TIMEZONE;
    return remoteEvents.flatMap((remote) =>
      parseICalendarEvents(remote.data, start, end, timezone).map((event) => ({
        ...event,
        id: event.recurrence_rule ? `${remote.href}#${event.start}` : remote.href,
        href: remote.href,
        etag: remote.etag,
        mailbox_id: mailbox.id,
        calendar_id: calendar.id,
      })),
    );
  }

  async freeBusy(
    workspaceId: string,
    ucUid: string | null,
    input: CalendarRange & { mailbox_id: string; calendar_id: string },
  ): Promise<{ busy: CalendarBusyInterval[] }> {
    const { start, end } = rangeDates(input);
    const { mailbox, calendar } = await this.calendarFor(
      workspaceId,
      ucUid,
      input.mailbox_id,
      input.calendar_id,
    );
    const credential = await this.credentialFor(mailbox);
    let busy = await this.caldav.freeBusy(credential, calendar.href, start, end);
    if (!busy.length) {
      const remoteEvents = await this.caldav.listEvents(credential, calendar.href, start, end);
      busy = remoteEvents.flatMap((remote) =>
        parseICalendarEvents(remote.data, start, end, calendar.timezone).map((event) => ({
          start: event.start,
          end: event.end,
          type: 'BUSY',
        })),
      );
    }
    return { busy: mergeBusy(busy, start, end) };
  }

  async findFreeTime(
    workspaceId: string,
    ucUid: string | null,
    input: CalendarFindFreeTimeInput,
  ): Promise<{ slots: Array<{ start: string; end: string; display_start: string; display_end: string }> }> {
    if (!Number.isInteger(input.duration_minutes) || input.duration_minutes < 5 || input.duration_minutes > 1_440) {
      throw new BadRequestException('duration_minutes must be between 5 and 1440.');
    }
    const { start, end } = rangeDates(input);
    const timezone = input.timezone || DEFAULT_CALENDAR_TIMEZONE;
    const workdayStart = timeParts(input.workday_start ?? '09:00');
    const workdayEnd = timeParts(input.workday_end ?? '17:00');
    const durationMs = input.duration_minutes * 60_000;
    const busy = (await this.freeBusy(workspaceId, ucUid, input)).busy;
    const limit = Math.min(20, Math.max(1, input.limit ?? 10));
    const slots: Array<{ start: string; end: string; display_start: string; display_end: string }> = [];
    for (let candidate = new Date(Math.ceil(start.getTime() / 1_800_000) * 1_800_000); candidate.getTime() + durationMs <= end.getTime(); candidate = new Date(candidate.getTime() + 1_800_000)) {
      const local = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(candidate);
      const values = new Map(local.map((part) => [part.type, part.value]));
      const weekday = values.get('weekday');
      const hour = Number(values.get('hour'));
      const minute = Number(values.get('minute'));
      const localMinutes = hour * 60 + minute;
      if (weekday === 'Sun' || weekday === 'Sat' || localMinutes < workdayStart.hour * 60 + workdayStart.minute || localMinutes + input.duration_minutes > workdayEnd.hour * 60 + workdayEnd.minute) continue;
      const candidateEnd = new Date(candidate.getTime() + durationMs);
      if (busy.some((interval) => new Date(interval.start) < candidateEnd && new Date(interval.end) > candidate)) continue;
      slots.push({
        start: candidate.toISOString(),
        end: candidateEnd.toISOString(),
        display_start: displayDate(candidate, timezone),
        display_end: displayDate(candidateEnd, timezone),
      });
      if (slots.length >= limit) break;
    }
    return { slots };
  }

  async createEvent(
    workspaceId: string,
    ucUid: string | null,
    input: CalendarEventInput & { mailbox_id: string; calendar_id: string },
  ): Promise<CalendarEventView> {
    const { mailbox, calendar } = await this.calendarFor(workspaceId, ucUid, input.mailbox_id, input.calendar_id);
    const credential = await this.credentialFor(mailbox);
    const normalized = calendarEventPayload({ ...input, uid: input.uid ?? randomUUID() });
    const data = serializeICalendarEvent(normalized);
    const written = await this.caldav.createEvent(credential, calendar.href, normalized.uid!, data);
    return this.localEvent(normalized, written.href, written.etag, mailbox.id, calendar.id);
  }

  async updateEvent(
    workspaceId: string,
    ucUid: string | null,
    input: CalendarEventInput & { mailbox_id: string; calendar_id: string; event_id: string; etag?: string | null },
  ): Promise<CalendarEventView> {
    const { mailbox, calendar } = await this.calendarFor(workspaceId, ucUid, input.mailbox_id, input.calendar_id);
    const credential = await this.credentialFor(mailbox);
    const eventHref = eventHrefFor(calendar.href, input.event_id);
    const uid = input.uid ?? uidFromHref(eventHref);
    const normalized = calendarEventPayload({ ...input, uid });
    const written = await this.caldav.updateEvent(
      credential,
      eventHref,
      serializeICalendarEvent(normalized),
      input.etag,
    );
    return this.localEvent(normalized, written.href, written.etag, mailbox.id, calendar.id);
  }

  async deleteEvent(
    workspaceId: string,
    ucUid: string | null,
    input: { mailbox_id: string; calendar_id: string; event_id: string; etag?: string | null },
  ): Promise<{ deleted: boolean }> {
    const { mailbox, calendar } = await this.calendarFor(workspaceId, ucUid, input.mailbox_id, input.calendar_id);
    const credential = await this.credentialFor(mailbox);
    await this.caldav.deleteEvent(credential, eventHrefFor(calendar.href, input.event_id), input.etag);
    return { deleted: true };
  }

  async stageCalendarAction(
    workspaceId: string,
    ucUid: string | null,
    payload: CalendarDraftPayload,
    draftedBy: string,
  ): Promise<{ status: 'pending_approval'; request: { id: string; summary: string; operation: string } }> {
    const parsed = getCalendarDraftPayload(payload);
    if (!parsed) throw new BadRequestException('Invalid calendar draft.');
    await this.mailboxOrThrow(workspaceId, ucUid, parsed.mailbox_id);
    const summary = parsed.operation === 'cancel' ? `Cancel calendar event ${parsed.event_id ?? ''}` : `${parsed.operation === 'create' ? 'Create' : 'Update'} calendar event: ${parsed.event?.summary ?? '(untitled)'}`;
    const request = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const item = await tx.agentInboxItem.create({
        data: {
          workspaceId,
          kind: AgentInboxKind.NOTICE,
          approvalTier: AgentInboxApprovalTier.MAILBOX_OWNER,
          draftedBy,
          summary,
          payload: parsed as unknown as object,
        },
      });
      await tx.agentActionEvent.create({
        data: {
          workspaceId,
          kind: AgentActionKind.STAGED_FOR_APPROVAL,
          agentKey: draftedBy,
          actorUcUid: ucUid,
          detail: summary,
        },
      });
      return item;
    });
    return { status: 'pending_approval', request: { id: request.id, summary, operation: parsed.operation } };
  }

  async applyCalendarDraft(
    workspaceId: string,
    ucUid: string | null,
    payload: CalendarDraftPayload,
  ): Promise<CalendarEventView | { deleted: boolean }> {
    const parsed = getCalendarDraftPayload(payload);
    if (!parsed) throw new BadRequestException('Invalid calendar draft.');
    if (parsed.operation === 'cancel') {
      if (!parsed.event_id) throw new BadRequestException('Calendar cancellation requires event_id.');
      return this.deleteEvent(workspaceId, ucUid, {
        mailbox_id: parsed.mailbox_id,
        calendar_id: parsed.calendar_id,
        event_id: parsed.event_id,
        etag: parsed.etag,
      });
    }
    if (!parsed.event) throw new BadRequestException('Calendar write requires event details.');
    if (parsed.operation === 'create') {
      return this.createEvent(workspaceId, ucUid, {
        ...parsed.event,
        mailbox_id: parsed.mailbox_id,
        calendar_id: parsed.calendar_id,
      });
    }
    if (!parsed.event_id) throw new BadRequestException('Calendar update requires event_id.');
    return this.updateEvent(workspaceId, ucUid, {
      ...parsed.event,
      mailbox_id: parsed.mailbox_id,
      calendar_id: parsed.calendar_id,
      event_id: parsed.event_id,
      etag: parsed.etag,
    });
  }

  private localEvent(
    input: CalendarEventInput,
    href: string,
    etag: string | null,
    mailboxId: string,
    calendarId: string,
  ): CalendarEventView {
    const start = new Date(input.start);
    const end = new Date(input.end);
    return {
      id: href,
      uid: input.uid!,
      href,
      etag,
      mailbox_id: mailboxId,
      calendar_id: calendarId,
      summary: input.summary,
      description: input.description ?? null,
      location: input.location ?? null,
      start: start.toISOString(),
      end: end.toISOString(),
      display_start: displayDate(start, input.timezone ?? DEFAULT_CALENDAR_TIMEZONE),
      display_end: displayDate(end, input.timezone ?? DEFAULT_CALENDAR_TIMEZONE),
      timezone: input.timezone ?? DEFAULT_CALENDAR_TIMEZONE,
      all_day: input.all_day === true,
      recurrence_rule: input.recurrence_rule ?? null,
      attendees: (input.attendees ?? []).map((address) => ({ address, name: null, role: null, status: null })),
      organizer: input.organizer ?? null,
      status: input.status ?? null,
      url: input.url ?? null,
    };
  }

}

function mergeBusy(intervals: CalendarBusyInterval[], rangeStart: Date, rangeEnd: Date): CalendarBusyInterval[] {
  const sorted = intervals
    .map((interval) => ({ start: new Date(interval.start), end: new Date(interval.end), type: interval.type ?? 'BUSY' }))
    .filter((interval) => !Number.isNaN(interval.start.getTime()) && !Number.isNaN(interval.end.getTime()) && interval.end > rangeStart && interval.start < rangeEnd)
    .map((interval) => ({
      start: new Date(Math.max(interval.start.getTime(), rangeStart.getTime())),
      end: new Date(Math.min(interval.end.getTime(), rangeEnd.getTime())),
      type: interval.type,
    }))
    .sort((left, right) => left.start.getTime() - right.start.getTime());
  const merged: CalendarBusyInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || new Date(previous.end).getTime() < interval.start.getTime()) {
      merged.push({ start: interval.start.toISOString(), end: interval.end.toISOString(), type: interval.type });
    } else if (new Date(previous.end).getTime() < interval.end.getTime()) {
      previous.end = interval.end.toISOString();
    }
  }
  return merged;
}

function eventHrefFor(calendarHref: string, eventId: string): string {
  const raw = eventId.split('#')[0];
  try {
    const event = new URL(raw, calendarHref);
    const calendar = new URL(calendarHref);
    if (event.origin !== calendar.origin || !event.pathname.startsWith(calendar.pathname)) {
      throw new Error('event is outside the selected calendar');
    }
    return event.toString();
  } catch {
    if (!/^[A-Za-z0-9._:@-]+$/.test(raw)) throw new BadRequestException('Invalid calendar event id.');
    return `${calendarHref.replace(/\/$/, '')}/${encodeURIComponent(raw)}.ics`;
  }
}

function uidFromHref(href: string): string {
  const last = href.split('/').pop() ?? '';
  return decodeURIComponent(last.replace(/\.ics(?:#.*)?$/, '')) || randomUUID();
}

function displayDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
