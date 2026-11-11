// Imported fixture only; the test below validates its redacted transcript.
import { Duplex } from 'node:stream';
import { ConnectionOptions } from 'node:tls';
import { SmtpConnection } from '../src/external-imap/smtp-connection';
import { fixturePassword, fixtureUsername } from './fake-imap.spec';

export class FakeSmtpServer extends SmtpConnection {
  starttls = true;
  refuseUpgrade = false;
  failCertificate = false;
  wrongPassword = false;
  silent = false;
  refuseRecipient = false;
  authMethod = 'PLAIN';
  options: ConnectionOptions[] = [];
  sockets: Duplex[] = [];
  commands: string[] = [];
  messages: Buffer[] = [];
  private encrypted = false;
  protected open(_host: string, port: number, options: ConnectionOptions) {
    this.options.push(options);
    this.encrypted = port === 465;
    let input = '';
    let auth: 'plain' | 'user' | 'password' | undefined;
    let data = false;
    const socket = new Duplex({
      read() {},
      write: (chunk, _encoding, done) => {
        input += chunk.toString();
        if (data) {
          const end = input.indexOf('\r\n.\r\n');
          if (end >= 0) {
            this.messages.push(Buffer.from(input.slice(0, end + 2).replace(/^\.\./gm, '.')));
            input = input.slice(end + 5);
            data = false;
            queueMicrotask(() => socket.push('250 accepted\r\n'));
          }
        }
        let end: number;
        while (!data && (end = input.indexOf('\r\n')) >= 0) {
          const line = input.slice(0, end);
          input = input.slice(end + 2);
          let response = '250 ok\r\n';
          if (auth) {
            this.commands.push('[authentication redacted]');
            const value = Buffer.from(line, 'base64').toString();
            if (auth === 'user') {
              auth = 'password';
              response = '334 UGFzc3dvcmQ6\r\n';
            } else {
              response =
                !this.wrongPassword && value.includes(fixturePassword)
                  ? '235 authenticated\r\n'
                  : `535 ${fixtureUsername} ${fixturePassword}\r\n`;
              auth = undefined;
            }
          } else {
            this.commands.push(line);
            if (line.startsWith('EHLO'))
              response = `250-example.com\r\n${this.starttls && !this.encrypted ? '250-STARTTLS\r\n' : ''}250 AUTH ${this.authMethod}\r\n`;
            else if (line === 'STARTTLS')
              response = this.refuseUpgrade ? '454 refused\r\n' : '220 start TLS\r\n';
            else if (line.startsWith('AUTH')) {
              if (!this.encrypted) throw new Error('Authentication before TLS');
              auth = line === 'AUTH PLAIN' ? 'plain' : 'user';
              response = '334 \r\n';
            } else if (line.startsWith('RCPT') && this.refuseRecipient)
              response = '550 refused\r\n';
            else if (line === 'DATA') {
              data = true;
              response = '354 continue\r\n';
            }
          }
          queueMicrotask(() => socket.push(response));
        }
        done();
      },
    });
    this.sockets.push(socket);
    queueMicrotask(() => {
      if (this.failCertificate && port === 465)
        socket.destroy(
          Object.assign(new Error('certificate unavailable'), { code: 'CERT_HAS_EXPIRED' }),
        );
      else if (!this.silent) socket.push('220 example.com ready\r\n');
    });
    return socket;
  }
  protected upgrade(socket: Duplex, options: ConnectionOptions) {
    this.options.push(options);
    this.encrypted = true;
    queueMicrotask(() => {
      if (this.failCertificate)
        socket.destroy(
          Object.assign(new Error('certificate unavailable'), { code: 'CERT_HAS_EXPIRED' }),
        );
      else socket.emit('secureConnect');
    });
    return socket;
  }
}
