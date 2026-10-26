import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CalendarDevicesService } from './calendar-devices.service';
import { CalendarBridgeClient } from './calendar-bridge.client';

function appId(): string {
  return ['app', 'runtime', 'device'].join('_');
}

function secret(): string {
  return ['runtime', 'secret'].join('-');
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-row-1',
    workspaceId: 'workspace-1',
    mailboxId: 'mailbox-1',
    label: 'Phone',
    davisAppId: appId(),
    createdById: 'human-1',
    createdAt: new Date('2026-10-25T12:00:00.000Z'),
    expiresAt: new Date('2027-10-25T12:00:00.000Z'),
    revokedAt: null,
    ...overrides,
  };
}

function harness() {
  const mailbox = {
    id: 'mailbox-1',
    emailAddress: 'person@example.test',
    provider: 'james',
    ownerKind: 'SHARED',
    ownerKey: null,
  };
  const tx = {
    mailboxAccount: {
      findFirst: jest.fn().mockResolvedValue(mailbox),
      findMany: jest.fn().mockResolvedValue([mailbox]),
    },
    membership: { findUnique: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    calendarDeviceKey: {
      findMany: jest.fn().mockResolvedValue([row()]),
      findFirst: jest.fn().mockResolvedValue(row()),
      create: jest.fn().mockResolvedValue(row()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    withWorkspace: jest.fn(
      async (_workspace: string, _ucUid: string | null, fn: (value: typeof tx) => unknown) =>
        fn(tx),
    ),
  };
  const bridge = {
    createKey: jest.fn().mockResolvedValue({
      app_id: appId(),
      secret: secret(),
      username: 'person@example.test*runtime-device',
      expires_at: '2027-10-25T12:00:00.000Z',
    }),
    revokeKey: jest.fn().mockResolvedValue({ confirmed: true }),
  };
  const config = {
    get: jest.fn((_key: string, fallback: string) => fallback),
  } as unknown as ConfigService;
  return {
    service: new CalendarDevicesService(
      prisma as never,
      bridge as unknown as CalendarBridgeClient,
      config,
    ),
    tx,
    prisma,
    bridge,
  };
}

describe('CalendarDevicesService', () => {
  it('creates a Davis key and persists only non-secret device metadata', async () => {
    const { service, tx, bridge } = harness();

    const result = await service.create('workspace-1', 'human-1', 'human-1', {
      mailboxId: 'mailbox-1',
      label: 'Phone',
    });

    expect(result).toMatchObject({
      id: 'device-row-1',
      server_url: 'https://calendar.unicorncommander.ai/dav',
      username: 'person@example.test*runtime-device',
      secret: secret(),
    });
    expect(bridge.createKey).toHaveBeenCalledWith(
      expect.objectContaining({ login: 'person@example.test', label: 'Phone', purpose: 'device' }),
      expect.stringMatching(/^calendar-device-/),
    );
    expect(tx.calendarDeviceKey.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({
        secret: expect.anything(),
        secretHash: expect.anything(),
      }),
    });
    expect(tx.calendarDeviceKey.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ davisAppId: appId(), createdById: 'human-1' }),
    );
  });

  it('lists device metadata without a credential field', async () => {
    const { service } = harness();
    const result = await service.list('workspace-1', 'human-1', 'mailbox-1');
    expect(result[0]).toEqual(expect.objectContaining({ label: 'Phone', davis_app_id: appId() }));
    expect(result[0]).not.toHaveProperty('secret');
    expect(result[0]).not.toHaveProperty('secret_hash');
  });

  it('reuses a local row when a retried bridge request already committed it', async () => {
    const { service, tx, bridge } = harness();
    tx.calendarDeviceKey.create.mockRejectedValue(new Error('response lost after commit'));

    const result = await service.create(
      'workspace-1',
      'human-1',
      'human-1',
      { mailboxId: 'mailbox-1', label: 'Phone' },
      'retry-key',
    );

    expect(result.secret).toBe(secret());
    expect(bridge.revokeKey).not.toHaveBeenCalled();
    expect(tx.calendarDeviceKey.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: 'workspace-1', davisAppId: appId() },
    });
  });

  it('leaves the local row visible when Davis does not confirm revoke', async () => {
    const { service, tx, bridge } = harness();
    bridge.revokeKey.mockRejectedValue(new Error('bridge unavailable'));

    await expect(service.revoke('workspace-1', 'human-1', 'device-row-1')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(tx.calendarDeviceKey.updateMany).not.toHaveBeenCalled();
  });

  it('marks the row revoked only after Davis confirms', async () => {
    const { service, tx, bridge } = harness();
    const calls: string[] = [];
    bridge.revokeKey.mockImplementation(async () => {
      calls.push('davis');
      return { confirmed: true };
    });
    tx.calendarDeviceKey.updateMany.mockImplementation(async () => {
      calls.push('database');
      return { count: 1 };
    });

    const result = await service.revoke('workspace-1', 'human-1', 'device-row-1');
    expect(result).toEqual({
      device: expect.objectContaining({ id: 'device-row-1', status: 'active' }),
      confirmed: true,
    });
    expect(calls).toEqual(['davis', 'database']);
  });
});
