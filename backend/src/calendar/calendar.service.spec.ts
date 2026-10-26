import { ServiceUnavailableException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalDavPort } from './caldav.port';
import { CalendarCredentialsPort } from './calendar-credentials.port';

function fakePrisma() {
  const tx = {
    mailboxAccount: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'mailbox-1',
        workspaceId: 'workspace-1',
        emailAddress: 'fictional@example.test',
        provider: 'james',
        ownerKind: 'SHARED',
        ownerKey: null,
      }),
      findMany: jest.fn().mockResolvedValue([{ id: 'mailbox-1' }]),
    },
    membership: { findUnique: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    agentInboxItem: { create: jest.fn().mockResolvedValue({ id: 'request-1' }) },
    agentActionEvent: { create: jest.fn().mockResolvedValue({ id: 'action-1' }) },
  };
  return {
    tx,
    prisma: {
      withWorkspace: jest.fn(async (_workspace: string, _uid: string | null, callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    },
  };
}

describe('CalendarService', () => {
  it('fails closed when no Davis credential resolver is installed', async () => {
    const { prisma, tx } = fakePrisma();
    const caldav = {
      listCalendars: jest.fn(),
    } as unknown as CalDavPort;
    const credentials = { resolve: jest.fn().mockResolvedValue(null) } as unknown as CalendarCredentialsPort;
    const service = new CalendarService(prisma as never, caldav, credentials);

    await expect(service.listCalendars('workspace-1', 'caller-1', 'mailbox-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(caldav.listCalendars).not.toHaveBeenCalled();
    expect(credentials.resolve).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({ emailAddress: 'fictional@example.test' }),
    );
  });

  it('stages an agent action without needing a mailbox password or remote call', async () => {
    const { prisma, tx } = fakePrisma();
    const caldav = { listCalendars: jest.fn() } as unknown as CalDavPort;
    const credentials = { resolve: jest.fn() } as unknown as CalendarCredentialsPort;
    const service = new CalendarService(prisma as never, caldav, credentials);

    const result = await service.stageCalendarAction(
      'workspace-1',
      'caller-1',
      {
        type: 'calendar_event_draft',
        operation: 'create',
        mailbox_id: 'mailbox-1',
        calendar_id: 'calendar-1',
        event: {
          summary: 'Fictional planning',
          start: '2026-10-25T13:00:00.000Z',
          end: '2026-10-25T14:00:00.000Z',
        },
      },
      'calendar-agent:caller-1',
    );

    expect(result).toEqual({
      status: 'pending_approval',
      request: { id: 'request-1', summary: 'Create calendar event: Fictional planning', operation: 'create' },
    });
    expect(tx.agentInboxItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'NOTICE', payload: expect.anything() }) }),
    );
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(caldav.listCalendars).not.toHaveBeenCalled();
  });

  it('uses free/busy intervals to return UTC slots with New York display values', async () => {
    const { prisma } = fakePrisma();
    const caldav = {
      listCalendars: jest.fn().mockResolvedValue([
        {
          id: 'calendar-1',
          mailbox_id: 'mailbox-1',
          href: 'https://calendar.example.test/dav/calendars/fictional/personal/',
          display_name: 'Personal',
          color: null,
          timezone: 'America/New_York',
          ctag: null,
        },
      ]),
      freeBusy: jest.fn().mockResolvedValue([
        { start: '2026-10-26T13:00:00.000Z', end: '2026-10-26T14:00:00.000Z', type: 'BUSY' },
      ]),
    } as unknown as CalDavPort;
    const credentials = { resolve: jest.fn().mockResolvedValue({ username: 'fictional@example.test', password: 'secret' }) } as unknown as CalendarCredentialsPort;
    const service = new CalendarService(prisma as never, caldav, credentials);

    const result = await service.findFreeTime('workspace-1', 'caller-1', {
      mailbox_id: 'mailbox-1',
      calendar_id: 'calendar-1',
      start: '2026-10-26T12:00:00.000Z',
      end: '2026-10-26T22:00:00.000Z',
      duration_minutes: 60,
      timezone: 'America/New_York',
      limit: 2,
    });

    expect(result.slots).toHaveLength(2);
    expect(result.slots[0].start).toBe('2026-10-26T14:00:00.000Z');
    expect(result.slots[0].display_start).toContain('10:00');
    expect(result.slots[1].start).toBe('2026-10-26T14:30:00.000Z');
  });
});
