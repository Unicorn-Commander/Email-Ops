import { ForbiddenException } from '@nestjs/common';
import { User } from '@prisma/client';
import { CalendarDevicesController } from './calendar-devices.controller';
import { CalendarDevicesService } from './calendar-devices.service';

const human = { id: 'human-1', keycloakId: 'human-key' } as User;

function controller() {
  return new CalendarDevicesController({
    list: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
    revoke: jest.fn().mockResolvedValue({}),
  } as unknown as CalendarDevicesService);
}

describe('CalendarDevicesController', () => {
  it.each([
    [
      'list',
      (c: CalendarDevicesController, request: any) =>
        c.list('workspace-1', human, request, { mailboxId: 'mailbox-1' }),
    ],
    [
      'create',
      (c: CalendarDevicesController, request: any) =>
        c.create('workspace-1', human, request, { mailboxId: 'mailbox-1', label: 'Phone' }),
    ],
    [
      'revoke',
      (c: CalendarDevicesController, request: any) =>
        c.revoke('workspace-1', human, request, 'device-row-1'),
    ],
  ])('rejects machine identities from %s', async (_name, call) => {
    const c = controller();
    await expect(call(c, { user: { ...human, __patAuth: { scopes: [] } } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(call(c, { user: { ...human, __isFederationActor: true } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('passes a human create through to the service', async () => {
    const c = controller();
    const result = await c.create(
      'workspace-1',
      human,
      { user: human } as any,
      { mailboxId: 'mailbox-1', label: 'Phone' },
      'retry-key',
    );
    expect(result).toEqual({});
  });
});
