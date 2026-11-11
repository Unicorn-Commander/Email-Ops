import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { ImapFlow, ImapFlowOptions } from 'imapflow';

const externalImapWorkspaceIds = () =>
  new Set(
    (process.env.EXTERNAL_IMAP_WORKSPACE_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );

export const externalImapEnabled = (workspaceId: string) =>
  process.env.EXTERNAL_IMAP_ENABLED === 'true' && externalImapWorkspaceIds().has(workspaceId);

export function requireExternalImap(workspaceId: string) {
  if (!externalImapEnabled(workspaceId)) throw new NotFoundException();
}

export type ConnectionStatus = 'ok' | 'auth_failed' | 'tls_failed' | 'unreachable';
export interface ImapCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  security: 'tls';
}

// A user-supplied destination must not become a route to internal services.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return !!family && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function connectionStatus(error: unknown): Exclude<ConnectionStatus, 'ok'> {
  // Only inspect machine codes, never return/log the remote response or message.
  const e = error as { code?: string; authenticationFailed?: boolean; tlsFailed?: boolean };
  if (e?.authenticationFailed) return 'auth_failed';
  if (e?.tlsFailed || /TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e?.code ?? ''))
    return 'tls_failed';
  return 'unreachable';
}

@Injectable()
export class ImapConnection implements OnModuleInit {
  onModuleInit() {
    if (process.env.EXTERNAL_IMAP_ENABLED === 'true' && externalImapWorkspaceIds().size === 0) {
      new Logger(ImapConnection.name).warn(
        'EXTERNAL_IMAP_ENABLED is true but EXTERNAL_IMAP_WORKSPACE_IDS is empty; external IMAP is disabled for every workspace.',
      );
    }
  }

  // Overridden only by the in-memory protocol fixture, never by API input.
  protected createClient(options: ImapFlowOptions): ImapFlow {
    return new ImapFlow(options);
  }

  async run<T>(
    workspaceId: string,
    credentials: ImapCredentials,
    operation: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    requireExternalImap(workspaceId);
    if (credentials.port !== 993 || credentials.security !== 'tls') {
      throw Object.assign(new Error('TLS required'), { tlsFailed: true });
    }
    const host = credentials.host.toLowerCase();
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
      throw new Error('Invalid IMAP host');
    }
    const tlsOptions: NonNullable<ImapFlowOptions['tls']> & { family: 4 } = {
      // Keep Node's socket lookup in single-address IPv4 mode.
      family: 4,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      servername: host,
      // Resolve and validate the exact address the TLS socket will connect to.
      lookup: (hostname, _options, callback) => {
        lookup(hostname, { family: 4 }, (error, address, family) => {
          if (error || !publicAddress(address)) {
            callback(error ?? new Error('Destination unavailable'), '', 4);
          } else callback(null, address, family);
        });
      },
    };
    const client = this.createClient({
      host,
      port: 993,
      secure: true,
      auth: { user: credentials.username, pass: credentials.password, loginMethod: 'LOGIN' },
      tls: tlsOptions,
      logger: false,
      logRaw: false,
      emitLogs: false,
      disableAutoIdle: true,
      disableCompression: true,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      maxLiteralSize: 26 * 1024 * 1024,
      maxResponseSize: 30 * 1024 * 1024,
    });
    // EventEmitter errors must never become unhandled exceptions with raw text.
    client.on('error', () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await client.connect();
          await client.mailboxOpen('INBOX');
          return operation(client);
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            client.close();
            reject(new Error('IMAP request timed out'));
          }, 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // No pooled sessions, IDLE, or unbounded LOGOUT wait.
      client.close();
    }
  }

  async test(
    workspaceId: string,
    credentials: ImapCredentials,
  ): Promise<{ status: ConnectionStatus }> {
    requireExternalImap(workspaceId);
    try {
      await this.run(workspaceId, credentials, async () => undefined);
      return { status: 'ok' };
    } catch (error) {
      return { status: connectionStatus(error) };
    }
  }
}
