/**
 * Small MIME reader for the Apache James numbered-part blob fallback.
 *
 * James exposes MIME leaves as `<messageId>_<partId>` blob ids. The normal
 * download route serves those ids, but some James deployments can serve the
 * parent message while returning 404 for a nested report leaf. This reader is
 * deliberately limited to the RFC 2045 structure needed to recover that leaf;
 * it is not a general-purpose mail parser.
 */

export interface JamesMimeLeaf {
  data: Buffer;
  contentType: string | null;
}

interface MimeEntity {
  headers: Map<string, string>;
  body: Buffer;
}

interface WalkResult {
  leaf: JamesMimeLeaf | null;
  nextPartId: number;
}

function splitEntity(raw: Buffer): MimeEntity {
  const text = raw.toString('latin1');
  const separator = /\r?\n\r?\n/.exec(text);
  if (!separator) return { headers: parseHeaders(raw), body: Buffer.alloc(0) };
  const headerEnd = separator.index;
  return {
    headers: parseHeaders(raw.subarray(0, headerEnd)),
    body: raw.subarray(headerEnd + separator[0].length),
  };
}

function parseHeaders(raw: Buffer): Map<string, string> {
  const fields = new Map<string, string>();
  let currentName: string | null = null;
  let currentValue = '';
  const commit = () => {
    if (currentName && !fields.has(currentName)) fields.set(currentName, currentValue.trim());
  };

  for (const line of raw.toString('latin1').split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentName) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    commit();
    const match = /^([^:\s]+):[ \t]*(.*)$/.exec(line);
    if (!match) {
      currentName = null;
      currentValue = '';
      continue;
    }
    currentName = match[1].toLowerCase();
    currentValue = match[2];
  }
  commit();
  return fields;
}

function mediaType(headers: Map<string, string>): string | null {
  const value = headers.get('content-type');
  if (!value) return null;
  const type = value.split(';', 1)[0]?.trim().toLowerCase();
  return type || null;
}

function boundary(headers: Map<string, string>): string | null {
  const value = headers.get('content-type');
  if (!value) return null;
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(value);
  return (match?.[1] ?? match?.[2] ?? '').trim() || null;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split a multipart body at delimiter lines, excluding the delimiter CRLF. */
function multipartChildren(body: Buffer, marker: string): Buffer[] {
  const text = body.toString('latin1');
  const delimiter = escapedRegExp(`--${marker}`);
  const delimiters = new RegExp(`(?:^|\\r?\\n)${delimiter}(--)?[ \\t]*(?:\\r?\\n|$)`, 'g');
  const children: Buffer[] = [];
  let contentStart: number | null = null;

  for (const match of text.matchAll(delimiters)) {
    const full = match[0];
    const startsWithLineBreak = full.startsWith('\r\n') ? 2 : full.startsWith('\n') ? 1 : 0;
    const delimiterStart = (match.index ?? 0) + startsWithLineBreak;
    const afterDelimiter = (match.index ?? 0) + full.length;
    const closing = Boolean(match[1]);

    if (contentStart === null) {
      if (!closing) contentStart = afterDelimiter;
      continue;
    }

    children.push(body.subarray(contentStart, delimiterStart));
    if (closing) break;
    contentStart = afterDelimiter;
  }
  return children;
}

function decodeQuotedPrintable(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '=') {
      bytes.push(text.charCodeAt(i));
      continue;
    }
    if (text[i + 1] === '\r' && text[i + 2] === '\n') {
      i += 2;
      continue;
    }
    if (text[i + 1] === '\n') {
      i += 1;
      continue;
    }
    const hex = text.slice(i + 1, i + 3);
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push('='.charCodeAt(0));
    }
  }
  return Buffer.from(bytes);
}

function decodeTransfer(body: Buffer, headers: Map<string, string>): Buffer {
  const encoding = headers.get('content-transfer-encoding')?.trim().toLowerCase();
  if (encoding === 'base64')
    return Buffer.from(body.toString('ascii').replace(/\s+/g, ''), 'base64');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

function walk(raw: Buffer, partId: number, targetPartId: number): WalkResult {
  const entity = splitEntity(raw);
  const type = mediaType(entity.headers);
  const partBoundary = boundary(entity.headers);
  if (type?.startsWith('multipart/') && partBoundary) {
    let nextPartId = partId + 1;
    for (const child of multipartChildren(entity.body, partBoundary)) {
      const childResult = walk(child, nextPartId, targetPartId);
      if (childResult.leaf) return childResult;
      nextPartId = childResult.nextPartId;
    }
    return { leaf: null, nextPartId };
  }

  return {
    leaf:
      partId === targetPartId
        ? { data: decodeTransfer(entity.body, entity.headers), contentType: type }
        : null,
    nextPartId: partId + 1,
  };
}

/** Extract a James numbered MIME leaf (`1` is the top-level message entity). */
export function extractJamesMimePart(raw: Buffer, targetPartId: number): JamesMimeLeaf | null {
  if (!Number.isSafeInteger(targetPartId) || targetPartId < 1) return null;
  return walk(raw, 1, targetPartId).leaf;
}
