import { Injectable, NotFoundException } from '@nestjs/common';
import { connect, Socket } from 'node:net';
import { connect as tlsConnect, ConnectionOptions } from 'node:tls';
import { Duplex } from 'node:stream';
import {
  connectionStatus,
  ConnectionStatus,
  externalImapEnabled,
  publicTlsOptions,
} from './imap-connection';

/** Verified identity tags, never request-body provenance. */
export function isHumanMailSession(user: object) {
  const identity = user as {
    __patAuth?: unknown;
    __isFederationActor?: unknown;
    __isFederationAuth?: unknown;
  };
  return !identity.__patAuth && !identity.__isFederationActor && !identity.__isFederationAuth;
}

export const externalImapSendEnabled = (workspaceId: string) =>
  externalImapEnabled(workspaceId) && process.env.EXTERNAL_IMAP_SEND_ENABLED === 'true';
export function requireExternalImapSend(workspaceId: string) {
  if (!externalImapSendEnabled(workspaceId)) throw new NotFoundException();
}
export interface SmtpSettings {
  host: string;
  port: 465 | 587;
  username?: string;
  password?: string;
}
export interface SmtpCredentials extends SmtpSettings {
  username: string;
  password: string;
}
const failure = (kind?: 'tlsFailed' | 'authenticationFailed') =>
  Object.assign(new Error('SMTP connection failed'), kind ? { [kind]: true } : {});

/** Bounded sequential SMTP replies. Remote text is never attached to an error. */
class Replies {
  private buffer = '';
  private lines: string[] = [];
  private bytes = 0;
  private pending?: { resolve: (lines: string[]) => void; reject: (e: Error) => void };
  private error?: Error;
  constructor(private readonly socket: Duplex) {
    socket.on('data', this.data);
    socket.on('error', this.failed);
    socket.on('close', this.closed);
  }
  private failed = (error: Error) => {
    this.error = error;
    this.pending?.reject(error);
    this.pending = undefined;
  };
  private closed = () => this.failed(failure());
  private data = (chunk: Buffer) => {
    this.bytes += chunk.length;
    if (this.bytes > 65536) return this.failed(failure());
    this.buffer += chunk.toString('ascii');
    let end: number;
    while ((end = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (!/^\d{3}[ -]/.test(line) || !this.pending) return this.failed(failure());
      if (this.lines.length && line.slice(0, 3) !== this.lines[0].slice(0, 3))
        return this.failed(failure());
      this.lines.push(line);
      if (line[3] === ' ') {
        this.pending.resolve(this.lines);
        this.pending = undefined;
        this.lines = [];
        this.bytes = 0;
      }
    }
  };
  async expect(
    code: number | number[],
    command?: string,
    kind?: 'tlsFailed' | 'authenticationFailed',
  ) {
    if (this.error) throw this.error;
    const reply = new Promise<string[]>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    if (command !== undefined) {
      try {
        this.socket.write(command + '\r\n');
      } catch {
        this.failed(failure());
      }
    }
    const lines = await reply;
    if (!(Array.isArray(code) ? code : [code]).includes(Number(lines[0].slice(0, 3))))
      throw failure(kind);
    return lines.map((line) => line.slice(4));
  }
  detach() {
    if (this.buffer || this.lines.length || this.error) throw failure('tlsFailed');
    this.socket.removeListener('data', this.data);
    this.socket.removeListener('error', this.failed);
    this.socket.removeListener('close', this.closed);
  }
}

@Injectable()
export class SmtpConnection {
  // Test subclasses supply in-memory streams. API input cannot replace transports.
  protected open(host: string, port: number, options: ConnectionOptions): Duplex {
    return port === 465
      ? tlsConnect({ ...options, host, port })
      : connect({ host, port, family: 4, lookup: options.lookup });
  }
  protected upgrade(socket: Duplex, options: ConnectionOptions): Duplex {
    return tlsConnect({ ...options, socket: socket as Socket });
  }
  async run(
    workspaceId: string,
    credentials: SmtpCredentials,
    message?: { from: string; recipients: string[]; raw: Buffer },
  ) {
    requireExternalImapSend(workspaceId);
    if (![465, 587].includes(credentials.port)) throw failure('tlsFailed');
    const options = publicTlsOptions(credentials.host);
    let socket = this.open(credentials.host.toLowerCase(), credentials.port, options);
    // Suppress unhandled transport errors even during STARTTLS transitions.
    socket.on('error', () => {});
    let replies = new Replies(socket);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await replies.expect(220);
          let capabilities = await replies.expect(250, 'EHLO email-ops.example.com');
          if (credentials.port === 587) {
            if (!capabilities.some((line) => /^STARTTLS(?:\s|$)/i.test(line)))
              throw failure('tlsFailed');
            await replies.expect(220, 'STARTTLS', 'tlsFailed');
            replies.detach();
            socket = this.upgrade(socket, options);
            await new Promise<void>((resolve, reject) => {
              socket.once('secureConnect', resolve);
              socket.once('error', reject);
              socket.once('close', () => reject(failure('tlsFailed')));
            });
            socket.on('error', () => {});
            replies = new Replies(socket);
            capabilities = await replies.expect(250, 'EHLO email-ops.example.com');
          }
          // AUTH is reached only after implicit TLS or a successful required upgrade.
          const auth = capabilities.find((line) => /^AUTH[ =]/i.test(line)) ?? '';
          if (/\bPLAIN\b/i.test(auth)) {
            const value = Buffer.from(
              `\0${credentials.username}\0${credentials.password}`,
            ).toString('base64');
            await replies.expect(334, 'AUTH PLAIN', 'authenticationFailed');
            await replies.expect(235, value, 'authenticationFailed');
          } else if (/\bLOGIN\b/i.test(auth)) {
            await replies.expect(334, 'AUTH LOGIN', 'authenticationFailed');
            await replies.expect(
              334,
              Buffer.from(credentials.username).toString('base64'),
              'authenticationFailed',
            );
            await replies.expect(
              235,
              Buffer.from(credentials.password).toString('base64'),
              'authenticationFailed',
            );
          } else throw failure('authenticationFailed');
          if (!message) return;
          await replies.expect(250, `MAIL FROM:<${message.from}>`);
          // Refuse before DATA if any recipient is rejected; never silently drop recipients.
          for (const address of message.recipients)
            await replies.expect([250, 251], `RCPT TO:<${address}>`);
          await replies.expect(354, 'DATA');
          await replies.expect(
            250,
            message.raw.toString('utf8').replace(/^\./gm, '..').replace(/\r\n$/, '') + '\r\n.',
          );
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            socket.destroy();
            reject(failure());
          }, 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }
  async test(
    workspaceId: string,
    credentials: SmtpCredentials,
  ): Promise<{ status: ConnectionStatus }> {
    requireExternalImapSend(workspaceId);
    try {
      await this.run(workspaceId, credentials);
      return { status: 'ok' };
    } catch (error) {
      return { status: connectionStatus(error) };
    }
  }
}
