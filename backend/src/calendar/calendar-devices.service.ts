import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CalendarDeviceKey } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertMailboxVisible } from '../common/mailbox/mailbox-scope';
import { CalendarBridgeClient, CalendarBridgeError } from './calendar-bridge.client';

const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_SERVER_URL = 'https://calendar.unicorncommander.ai/dav';

interface DeviceMailbox {
  id: string;
  emailAddress: string;
  provider: string;
  ownerKind: string;
  ownerKey: string | null;
}

export interface CalendarDeviceView {
  id: string;
  mailbox_id: string;
  label: string;
  davis_app_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export interface CalendarDeviceSecret extends CalendarDeviceView {
  server_url: string;
  username: string;
  secret: string;
}

@Injectable()
export class CalendarDevicesService {
  private readonly serverUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: CalendarBridgeClient,
    config: ConfigService,
  ) {
    this.serverUrl = (
      config.get<string>(
        'CALENDAR_SERVER_URL',
        config.get<string>('DAVIS_CALDAV_URL', DEFAULT_SERVER_URL),
      ) ?? DEFAULT_SERVER_URL
    )
      .trim()
      .replace(/\/+$/, '');
  }

  async list(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<CalendarDeviceView[]> {
    await this.visibleMailbox(workspaceId, ucUid, mailboxId);
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const rows = await tx.calendarDeviceKey.findMany({
        where: { workspaceId, mailboxId },
        orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      });
      return rows.map((row) => this.toView(row));
    });
  }

  async create(
    workspaceId: string,
    ucUid: string | null,
    createdById: string,
    input: { mailboxId: string; label: string },
    idempotencyKey?: string,
  ): Promise<CalendarDeviceSecret> {
    const mailbox = await this.visibleMailbox(workspaceId, ucUid, input.mailboxId);
    const label = normalizeLabel(input.label);
    const requestKey = idempotencyKey?.trim() || `calendar-device-${randomUUID()}`;

    let remote: Awaited<ReturnType<CalendarBridgeClient['createKey']>>;
    try {
      remote = await this.bridge.createKey(
        {
          login: mailbox.emailAddress.trim().toLowerCase(),
          label,
          purpose: 'device',
          ttl_seconds: DEVICE_TTL_SECONDS,
        },
        requestKey,
      );
    } catch (error) {
      if (error instanceof CalendarBridgeError && error.status === 409) {
        throw new ConflictException('The Davis mailbox is not ready for a device key.');
      }
      throw new ServiceUnavailableException('The calendar device-key service is unavailable.');
    }

    const expiresAt = new Date(remote.expires_at);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      await this.revokeBestEffort(remote.app_id);
      throw new ServiceUnavailableException(
        'The calendar device-key service returned an invalid expiry.',
      );
    }

    let row;
    try {
      row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
        tx.calendarDeviceKey.create({
          data: {
            workspaceId,
            mailboxId: mailbox.id,
            label,
            davisAppId: remote.app_id,
            createdById,
            expiresAt,
          },
        }),
      );
    } catch {
      // Davis is authoritative, but an orphaned bridge key would be invisible
      // to the Email-Ops device list. Remove it before returning an error.
      await this.revokeBestEffort(remote.app_id);
      throw new ServiceUnavailableException('The calendar device key could not be recorded.');
    }

    return {
      ...this.toView(row),
      server_url: this.serverUrl,
      username: remote.username,
      secret: remote.secret,
    };
  }

  async revoke(
    workspaceId: string,
    ucUid: string | null,
    id: string,
  ): Promise<{ device: CalendarDeviceView; confirmed: true }> {
    const existing = await this.loadVisibleKey(workspaceId, ucUid, id);
    if (existing.row.revokedAt) {
      return { device: this.toView(existing.row), confirmed: true };
    }

    try {
      await this.bridge.revokeKey(existing.row.davisAppId);
    } catch {
      // Do not mark the local row revoked unless Davis confirmed it. The row
      // remains visible so the operator can retry the idempotent revoke.
      throw new BadGatewayException('The Davis device-key revoke could not be confirmed.');
    }

    try {
      const revokedAt = new Date();
      const updated = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
        await tx.calendarDeviceKey.updateMany({
          where: { id, workspaceId, revokedAt: null },
          data: { revokedAt },
        });
        const row = await tx.calendarDeviceKey.findFirst({ where: { id, workspaceId } });
        if (!row) throw new NotFoundException('Calendar device key not found.');
        return row;
      });
      return { device: this.toView(updated), confirmed: true };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      // Davis already confirmed the revoke, but the local marker is still
      // missing. Keeping the row visible makes a retry safe and observable.
      throw new ServiceUnavailableException(
        'Davis revoked the key, but Email-Ops could not record it.',
      );
    }
  }

  private async visibleMailbox(
    workspaceId: string,
    ucUid: string | null,
    mailboxId: string,
  ): Promise<DeviceMailbox> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const mailbox = await tx.mailboxAccount.findFirst({
        where: { id: mailboxId, workspaceId },
        select: { id: true, emailAddress: true, provider: true, ownerKind: true, ownerKey: true },
      });
      if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
      await assertMailboxVisible(tx, workspaceId, ucUid, mailbox);
      this.assertDavisMailbox(mailbox.provider);
      return mailbox;
    });
  }

  private async loadVisibleKey(
    workspaceId: string,
    ucUid: string | null,
    id: string,
  ): Promise<{ row: CalendarDeviceKey; mailbox: DeviceMailbox }> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const row = await tx.calendarDeviceKey.findFirst({ where: { id, workspaceId } });
      if (!row) throw new NotFoundException('Calendar device key not found.');
      const mailbox = await tx.mailboxAccount.findFirst({
        where: { id: row.mailboxId, workspaceId },
        select: { id: true, emailAddress: true, provider: true, ownerKind: true, ownerKey: true },
      });
      if (!mailbox) throw new NotFoundException('Mailbox not found in this workspace.');
      await assertMailboxVisible(tx, workspaceId, ucUid, mailbox);
      this.assertDavisMailbox(mailbox.provider);
      return { row, mailbox };
    });
  }

  private assertDavisMailbox(provider: string): void {
    if (!['james', 'stalwart'].includes(provider.toLowerCase())) {
      throw new BadRequestException(
        'Calendar device keys are available only for a Davis-backed mailbox.',
      );
    }
  }

  private async revokeBestEffort(appId: string): Promise<void> {
    try {
      await this.bridge.revokeKey(appId);
    } catch {
      // Davis expiry remains the backstop. Do not expose bridge details.
    }
  }

  private toView(row: CalendarDeviceKey): CalendarDeviceView {
    const status = row.revokedAt
      ? 'revoked'
      : row.expiresAt.getTime() <= Date.now()
        ? 'expired'
        : 'active';
    return {
      id: row.id,
      mailbox_id: row.mailboxId,
      label: row.label,
      davis_app_id: row.davisAppId,
      created_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      revoked_at: row.revokedAt?.toISOString() ?? null,
      status,
    };
  }
}

function normalizeLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 64 || !/^[\x20-\x7e]+$/.test(label)) {
    throw new BadRequestException('label must be 64 or fewer printable characters.');
  }
  return label;
}
