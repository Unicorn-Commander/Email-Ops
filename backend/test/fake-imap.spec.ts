// Real IMAP wire protocol over an in-memory Duplex. No listening ports or DNS.
import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { ImapTransport, ImapTransportConnectOptions, ImapTransportSocket } from 'imapflow';

export const fixturePassword = randomBytes(24).toString('hex');
export const fixtureUsername = 'reader@example.com';
export const credentials = {
  host: 'imap.example.com',
  port: 993,
  security: 'tls' as const,
  username: fixtureUsername,
  password: fixturePassword,
};

export class FakeImapServer implements ImapTransport {
  commands: string[] = [];
  sockets: ImapTransportSocket[] = [];
  connections: ImapTransportConnectOptions[] = [];
  seen = new Set<number>();
  validity = 42;
  empty = false;
  failureCode: string | null = null;
  refuseInbox = false;
  silent = false;
  // RFC 3501 BODYSTRUCTURE: text plus an attachment, no attachment bytes inline.
  readonly structure =
    '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL)("APPLICATION" "OCTET-STREAM" ("NAME" "note.txt") NIL NIL "BASE64" 8 NIL ("ATTACHMENT" ("FILENAME" "note.txt")) NIL NIL) "MIXED" ("BOUNDARY" "fixture") NIL NIL NIL)';

  connect(options: ImapTransportConnectOptions, connected: () => void): ImapTransportSocket {
    this.connections.push(options);
    let input = '';
    const socket = new Duplex({
      read() {},
      write: (chunk, _encoding, done) => {
        input += chunk.toString();
        let index: number;
        while ((index = input.indexOf('\r\n')) >= 0) {
          const line = input.slice(0, index);
          input = input.slice(index + 2);
          queueMicrotask(() => this.respond(socket, line));
        }
        done();
      },
    }) as ImapTransportSocket;
    socket.setTimeout = () => socket;
    socket.authorized = true;
    this.sockets.push(socket);
    queueMicrotask(() => {
      if (this.failureCode) {
        socket.destroy(
          Object.assign(new Error(`${fixtureUsername} ${fixturePassword}`), {
            code: this.failureCode,
          }),
        );
      } else {
        connected();
        if (!this.silent) socket.push('* OK IMAP fixture ready\r\n');
      }
    });
    return socket;
  }

  private respond(socket: Duplex, line: string) {
    if (socket.destroyed) return;
    const [tag, verb] = line.split(' ');
    // Even test transcripts redact authentication commands.
    this.commands.push(verb === 'LOGIN' ? 'LOGIN [redacted]' : line.slice(tag.length + 1));
    const ok = (data = '') => socket.push(`${data}${tag} OK completed\r\n`);
    switch (verb) {
      case 'CAPABILITY':
        ok('* CAPABILITY IMAP4rev1 NAMESPACE\r\n');
        return;
      case 'LOGIN':
        if (line.includes(fixturePassword) && line.includes(fixtureUsername)) ok();
        else
          socket.push(`${tag} NO [AUTHENTICATIONFAILED] ${fixtureUsername} ${fixturePassword}\r\n`);
        return;
      case 'NAMESPACE':
        ok('* NAMESPACE (("" "/")) NIL NIL\r\n');
        return;
      case 'LIST':
        ok('* LIST (\\HasNoChildren) "/" "INBOX"\r\n');
        return;
      case 'LSUB':
        ok('* LSUB () "/" "INBOX"\r\n');
        return;
      case 'SELECT':
        if (this.refuseInbox) socket.push(`${tag} NO ${fixtureUsername} ${fixturePassword}\r\n`);
        else
          ok(
            `* FLAGS (\\Seen)\r\n* ${this.empty ? 0 : 3} EXISTS\r\n* OK [UIDVALIDITY ${this.validity}] valid\r\n* OK [PERMANENTFLAGS (\\Seen)] flags\r\n* OK [UIDNEXT 4] next\r\n`,
          );
        return;
      case 'STATUS':
        ok(
          `* STATUS "INBOX" (MESSAGES ${this.empty ? 0 : 3} UNSEEN ${this.empty ? 0 : 3 - this.seen.size})\r\n`,
        );
        return;
      case 'FETCH':
      case 'UID': {
        const match = /(?:UID )?(FETCH|STORE) ([\d,:*]+) (.*)/.exec(line);
        if (!match) break;
        const [, operation, range, query] = match;
        const uids = range.includes(':') ? [1, 2, 3] : range.split(',').map(Number);
        if (operation === 'STORE') {
          for (const uid of uids) {
            if (query.includes('+FLAGS')) this.seen.add(uid);
            else this.seen.delete(uid);
          }
          ok();
          return;
        }
        for (const uid of uids) {
          if (![1, 2, 3].includes(uid)) continue;
          const fields = [`UID ${uid}`];
          if (query.includes('FLAGS')) fields.push(`FLAGS (${this.seen.has(uid) ? '\\Seen' : ''})`);
          if (query.includes('BODYSTRUCTURE')) fields.push(`BODYSTRUCTURE ${this.structure}`);
          if (query.includes('INTERNALDATE'))
            fields.push(`INTERNALDATE "0${uid}-Nov-2026 10:00:00 +0000"`);
          if (query.includes('ENVELOPE'))
            fields.push(
              `ENVELOPE ("0${uid} Nov 2026 10:00:00 +0000" "${uid === 2 ? 'Re: Plans' : uid === 1 ? 'Plans' : 'Unrelated'}" (("Sender" NIL "sender" "example.com")) NIL NIL ((NIL NIL "reader" "example.com")) NIL NIL ${uid === 2 ? '"<one@example.com>"' : 'NIL'} "<${uid === 1 ? 'one' : uid === 2 ? 'two' : 'three'}@example.com>")`,
            );
          const sections = [...query.matchAll(/BODY\.PEEK\[([^\]]+)\](?:<(\d+)\.(\d+)>)?/g)];
          for (const section of sections) {
            const name = section[1];
            let content: string;
            if (name.startsWith('HEADER.FIELDS'))
              content = uid === 2 ? 'References: <one@example.com>\r\n\r\n' : '\r\n';
            else if (name === '1.MIME')
              content =
                'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n';
            else if (name === '2.MIME')
              content =
                'Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\n';
            else content = name === '1' ? 'Hello inbox!' : 'aGVsbG8=';
            if (section[2])
              content = content.slice(Number(section[2]), Number(section[2]) + Number(section[3]));
            fields.push(
              `BODY[${name}]${section[2] ? `<${section[2]}>` : ''} {${Buffer.byteLength(content)}}\r\n${content}`,
            );
          }
          socket.push(`* ${uid} FETCH (${fields.join(' ')})\r\n`);
        }
        ok();
        return;
      }
      case 'LOGOUT':
        socket.push(`* BYE closing\r\n${tag} OK done\r\n`);
        return;
    }
    socket.push(`${tag} BAD Unsupported fixture command\r\n`);
  }
}
