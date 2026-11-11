import { randomUUID } from 'node:crypto';
import { MailProviderSendRequest } from '../mail-provider/mail-provider.port';

// Restrict envelope addresses to printable ASCII addr-specs. SMTPUTF8 is not
// negotiated. Reject display names/control characters rather than changing recipients.
export function smtpAddress(value: string) {
  if (
    value.length > 254 ||
    !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(
      value,
    )
  )
    throw new Error('Invalid mail address');
  return value;
}
function base64(value: Buffer) {
  return (
    value
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  );
}
function encodedWords(value: string) {
  // Split on code points so Unicode characters cannot be torn across encoded words.
  const words: string[] = [];
  let part = '';
  for (const character of value) {
    if (Buffer.byteLength(part + character) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`);
      part = '';
    }
    part += character;
  }
  if (part) words.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`);
  return words.join('\r\n ');
}
function multipart(kind: string, parts: string[]) {
  const boundary = `emailops-${randomUUID()}`;
  return (
    `Content-Type: multipart/${kind}; boundary="${boundary}"\r\n\r\n` +
    parts.map((part) => `--${boundary}\r\n${part}\r\n`).join('') +
    `--${boundary}--\r\n`
  );
}
export function smtpMessage(
  fromAddress: string,
  req: MailProviderSendRequest,
  reply?: { parent: string; references: string[] },
) {
  const from = smtpAddress(fromAddress);
  const to = (req.toAddresses?.length ? req.toAddresses : [req.to]).map(smtpAddress);
  const cc = (req.cc ?? []).map(smtpAddress);
  const bcc = (req.bcc ?? []).map(smtpAddress);
  const id = `<${randomUUID()}@${from.split('@')[1]}>`;
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${id}`,
    `From: ${from}`,
    `To: ${to.join(',\r\n ')}`,
    ...(cc.length ? [`Cc: ${cc.join(',\r\n ')}`] : []),
    `Subject: ${encodedWords(req.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (reply) {
    const ids = [...new Set([...reply.references, reply.parent])];
    if (ids.some((value) => !/^<[^<>\s\x00-\x20\x7f-\uffff]+>$/.test(value) || value.length > 900))
      throw new Error('Invalid reply headers');
    headers.push(`In-Reply-To: ${reply.parent}`, `References: ${ids.join('\r\n ')}`);
  }
  const text = (kind: string, value: string) =>
    `Content-Type: text/${kind}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(Buffer.from(value))}\r\n`;
  let body = text('plain', req.body);
  if (req.bodyHtml) body = multipart('alternative', [body, text('html', req.bodyHtml)]);
  if (req.attachments?.length) {
    body = multipart('mixed', [
      body,
      ...req.attachments.map((attachment) => {
        if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(attachment.mimeType))
          throw new Error('Invalid attachment type');
        const segments = encodeURIComponent(attachment.filename)
          .replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
          .match(/(?:%[0-9A-F]{2}|[^%]){1,16}/g) ?? ['attachment'];
        const filename = segments
          .map((part, index) => `filename*${index}*=${index === 0 ? "utf-8''" : ''}${part}`)
          .join(';\r\n ');
        return `Content-Type: ${attachment.mimeType}\r\nContent-Disposition: attachment;\r\n ${filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(Buffer.from(attachment.contentBase64, 'base64'))}\r\n`;
      }),
    ]);
  }
  const raw = Buffer.from(headers.join('\r\n') + '\r\n' + body);
  if (raw.length > 25 * 1024 * 1024) throw new Error('Message exceeds size limit');
  return { id, from, recipients: [...new Set([...to, ...cc, ...bcc])], raw };
}
