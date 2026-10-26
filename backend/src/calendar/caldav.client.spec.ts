import { ConfigService } from '@nestjs/config';
import { CalDavClient } from './caldav.client';

describe('CalDavClient', () => {
  const base = 'https://calendar.example.test/dav';
  let client: CalDavClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    client = new CalDavClient({
      get: jest.fn((key: string, fallback: string) =>
        key === 'DAVIS_CALDAV_URL' ? base : fallback,
      ),
    } as unknown as ConfigService);
    fetchMock = jest.spyOn(globalThis, 'fetch') as unknown as jest.Mock;
  });

  afterEach(() => jest.restoreAllMocks());

  it('lists calendars and sends Basic auth without exposing the password in the URL', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/fictional%40example.test/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Personal</d:displayname><d:getctag>7</d:getctag></d:prop></d:propstat></d:response></d:multistatus>',
        { status: 207 },
      ),
    );

    const calendars = await client.listCalendars(
      { username: 'fictional@example.test', password: 'one-time-secret' },
      'fictional@example.test',
      'mailbox-1',
    );
    expect(calendars[0]).toMatchObject({ display_name: 'Personal', mailbox_id: 'mailbox-1', ctag: '7' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://calendar.example.test/dav/calendars/fictional%40example.test/',
      expect.objectContaining({ method: 'PROPFIND' }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('fictional@example.test:one-time-secret').toString('base64')}`,
    });
    expect(fetchMock.mock.calls[0][0]).not.toContain('one-time-secret');
  });

  it('parses REPORT calendar data and carries ETags through update/delete', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/fictional%40example.test/personal/event.ics</d:href><d:propstat><d:prop><d:getetag>&quot;abc&quot;</d:getetag><c:calendar-data>BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:event\r\nDTSTART:20261025T130000Z\r\nDTEND:20261025T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>',
          { status: 207 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { etag: '"next"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const events = await client.listEvents(
      { username: 'fictional@example.test', password: 'secret' },
      `${base}/calendars/fictional%40example.test/personal/`,
      new Date('2026-10-25T00:00:00Z'),
      new Date('2026-10-26T00:00:00Z'),
    );
    expect(events).toEqual([
      expect.objectContaining({ href: `${base}/calendars/fictional%40example.test/personal/event.ics`, etag: '"abc"' }),
    ]);
    const written = await client.updateEvent(
      { username: 'fictional@example.test', password: 'secret' },
      events[0].href,
      'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      events[0].etag,
    );
    expect(written).toEqual({ href: events[0].href, etag: '"next"' });
    await client.deleteEvent(
      { username: 'fictional@example.test', password: 'secret' },
      events[0].href,
      written.etag,
    );
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'PUT' }));
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({ 'If-Match': '"abc"' });
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({ method: 'DELETE' }));
  });
});
