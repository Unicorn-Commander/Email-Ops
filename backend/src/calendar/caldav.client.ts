import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CalDavPort, CalDavRemoteEvent, CalDavWriteResult } from './caldav.port';
import {
  CalendarBusyInterval,
  CalendarCredential,
  CalendarView,
} from './calendar.types';

const DEFAULT_DAVIS_URL = 'https://calendar.unicorncommander.ai/dav';

function xmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagValue(xml: string, name: string): string | null {
  const pattern = new RegExp(
    `<(?:(?:[A-Za-z0-9_.-]+):)?${name}\\b[^>]*>([\\s\\S]*?)</(?:(?:[A-Za-z0-9_.-]+):)?${name}>`,
    'i',
  );
  const match = xml.match(pattern);
  return match ? xmlText(match[1].trim()) : null;
}

function responseBlocks(xml: string): string[] {
  return [...xml.matchAll(/<(?:(?:[A-Za-z0-9_.-]+):)?response\b[^>]*>[\s\S]*?<\/(?:(?:[A-Za-z0-9_.-]+):)?response>/gi)].map(
    (match) => match[0],
  );
}

function calendarResource(block: string): boolean {
  return /<(?:[A-Za-z0-9_.-]+:)?calendar\b/i.test(tagValue(block, 'resourcetype') ?? '');
}

function calendarData(block: string): string | null {
  const match = block.match(
    /<(?:(?:[A-Za-z0-9_.-]+):)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_.-]+):)?calendar-data>/i,
  );
  return match ? xmlText(match[1].trim()) : null;
}

function hrefFor(base: URL, href: string): string {
  const resolved = new URL(href, base);
  if (resolved.origin !== base.origin) throw new Error('Davis returned a cross-origin CalDAV href.');
  return resolved.toString();
}

function icalDate(value: string): Date | null {
  const match = value.match(/^(\d{8})T(\d{6})Z?$/);
  if (!match) return null;
  const date = match[1];
  const time = match[2];
  const parsed = new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(4, 6)) - 1,
      Number(date.slice(6, 8)),
      Number(time.slice(0, 2)),
      Number(time.slice(2, 4)),
      Number(time.slice(4, 6)),
    ),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseFreeBusy(data: string): CalendarBusyInterval[] {
  const busy: CalendarBusyInterval[] = [];
  for (const line of data.replace(/\r\n[ \t]/g, '').split(/\r?\n/)) {
    if (!/^FREEBUSY(?:;[^:]+)?:/i.test(line)) continue;
    const value = line.slice(line.indexOf(':') + 1);
    for (const period of value.split(',')) {
      const [startToken, endToken] = period.split('/');
      const start = icalDate(startToken);
      if (!start) continue;
      const end = endToken?.startsWith('P')
        ? new Date(start.getTime() + parseDuration(endToken))
        : icalDate(endToken ?? '');
      if (end && end > start) {
        busy.push({ start: start.toISOString(), end: end.toISOString(), type: 'BUSY' });
      }
    }
  }
  return busy;
}

function parseDuration(value: string): number {
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return 0;
  return (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;
}

function parseEventBusy(data: string): CalendarBusyInterval[] {
  const startMatch = data.match(/(?:^|\r?\n)DTSTART(?:;[^:]+)?:([^\r\n]+)/i);
  const endMatch = data.match(/(?:^|\r?\n)DTEND(?:;[^:]+)?:([^\r\n]+)/i);
  if (!startMatch || !endMatch) return [];
  const start = icalDate(startMatch[1]);
  const end = icalDate(endMatch[1]);
  return start && end && end > start
    ? [{ start: start.toISOString(), end: end.toISOString(), type: 'BUSY' }]
    : [];
}

@Injectable()
export class CalDavClient extends CalDavPort {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.base = new URL(config.get<string>('DAVIS_CALDAV_URL', DEFAULT_DAVIS_URL));
    this.timeoutMs = Math.min(
      30_000,
      Math.max(1_000, Number(config.get<string>('DAVIS_CALDAV_TIMEOUT_MS', '10000')) || 10_000),
    );
  }

  private authHeaders(credential: CalendarCredential): Record<string, string> {
    return {
      Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`, 'utf8').toString('base64')}`,
      Accept: 'application/xml, text/calendar, */*',
      'User-Agent': 'Email-Ops-Calendar/2',
    };
  }

  private homeHref(mailboxEmail: string): string {
    const path = this.base.pathname.replace(/\/$/, '');
    return new URL(`${path}/calendars/${encodeURIComponent(mailboxEmail)}/`, this.base.origin).toString();
  }

  private async request(
    credential: CalendarCredential,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...this.authHeaders(credential), ...(init.headers ?? {}) },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) {
        throw new Error(`Davis CalDAV request failed with HTTP ${response.status}.`);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private async report(
    credential: CalendarCredential,
    href: string,
    body: string,
  ): Promise<string> {
    const response = await this.request(credential, href, {
      method: 'REPORT',
      headers: {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body,
    });
    return response.text();
  }

  async listCalendars(
    credential: CalendarCredential,
    mailboxEmail: string,
    mailboxId: string,
  ): Promise<CalendarView[]> {
    const home = this.homeHref(mailboxEmail);
    const response = await this.request(credential, home, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body:
        '<?xml version="1.0" encoding="utf-8" ?><propfind xmlns="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav"><prop><displayname/><resourcetype/><getctag/><c:supported-calendar-component-set/></prop></propfind>',
    });
    const xml = await response.text();
    return responseBlocks(xml)
      .filter(calendarResource)
      .map((block) => {
        const href = tagValue(block, 'href');
        if (!href) return null;
        const resolved = hrefFor(this.base, href);
        return {
          id: resolved,
          mailbox_id: mailboxId,
          href: resolved,
          display_name: tagValue(block, 'displayname') ?? 'Calendar',
          color: tagValue(block, 'calendar-color'),
          timezone: tagValue(block, 'calendar-timezone') ?? 'America/New_York',
          ctag: tagValue(block, 'getctag'),
        } satisfies CalendarView;
      })
      .filter((calendar): calendar is CalendarView => calendar !== null);
  }

  async listEvents(
    credential: CalendarCredential,
    calendarHref: string,
    start: Date,
    end: Date,
  ): Promise<CalDavRemoteEvent[]> {
    const href = hrefFor(this.base, calendarHref);
    const xml = await this.report(
      credential,
      href,
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icalDateToken(start)}" end="${icalDateToken(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
    );
    return responseBlocks(xml)
      .map((block) => {
        const remoteHref = tagValue(block, 'href');
        const data = calendarData(block);
        if (!remoteHref || !data) return null;
        return {
          href: hrefFor(this.base, remoteHref),
          etag: tagValue(block, 'getetag'),
          data,
        };
      })
      .filter((event): event is CalDavRemoteEvent => event !== null);
  }

  async freeBusy(
    credential: CalendarCredential,
    calendarHref: string,
    start: Date,
    end: Date,
  ): Promise<CalendarBusyInterval[]> {
    const href = hrefFor(this.base, calendarHref);
    const xml = await this.report(
      credential,
      href,
      `<c:free-busy-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="${icalDateToken(start)}" end="${icalDateToken(end)}"/></c:free-busy-query>`,
    );
    const blocks = responseBlocks(xml);
    const busy = blocks.flatMap((block) => parseFreeBusy(calendarData(block) ?? ''));
    if (busy.length) return busy;
    return blocks.flatMap((block) => parseEventBusy(calendarData(block) ?? ''));
  }

  async createEvent(
    credential: CalendarCredential,
    calendarHref: string,
    uid: string,
    data: string,
  ): Promise<CalDavWriteResult> {
    const href = `${hrefFor(this.base, calendarHref).replace(/\/$/, '')}/${encodeURIComponent(uid)}.ics`;
    return this.put(credential, href, data, { 'If-None-Match': '*' });
  }

  async updateEvent(
    credential: CalendarCredential,
    eventHref: string,
    data: string,
    etag?: string | null,
  ): Promise<CalDavWriteResult> {
    return this.put(credential, hrefFor(this.base, eventHref), data, etag ? { 'If-Match': etag } : {});
  }

  private async put(
    credential: CalendarCredential,
    href: string,
    data: string,
    conditional: Record<string, string>,
  ): Promise<CalDavWriteResult> {
    const response = await this.request(credential, href, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...conditional },
      body: data,
    });
    return { href, etag: response.headers.get('etag') };
  }

  async deleteEvent(
    credential: CalendarCredential,
    eventHref: string,
    etag?: string | null,
  ): Promise<void> {
    await this.request(credential, hrefFor(this.base, eventHref), {
      method: 'DELETE',
      headers: etag ? { 'If-Match': etag } : {},
    });
  }
}

function icalDateToken(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
}
