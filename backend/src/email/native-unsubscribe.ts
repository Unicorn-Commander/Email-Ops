import type {
  StalwartMessageDetail,
  StalwartSendRequest,
  StalwartSendResult,
} from '../stalwart/stalwart.types';
import type {
  NativeUnsubscribeHttpPort,
  NativeUnsubscribeHttpResult,
} from './native-unsubscribe-http';

/** The bounded payload retained on a native unsubscribe approval item. */
export interface NativeUnsubscribeTarget {
  thread_id: string;
  message_id: string;
  mailbox: string;
  sender: string | null;
  subject: string | null;
  one_click_url?: string;
  mailto?: string;
  rationale: string;
}

export interface NativeUnsubscribeSkippedThread {
  thread_id: string;
  reason: string;
}

export interface NativeUnsubscribeTargetResolution {
  targets: NativeUnsubscribeTarget[];
  skipped: NativeUnsubscribeSkippedThread[];
}

export type NativeUnsubscribeMethod = 'one_click' | 'mailto' | 'none';
export type NativeUnsubscribeStatus = 'unsubscribed' | 'failed';

export interface NativeUnsubscribeThreadResult {
  thread_id: string;
  status: NativeUnsubscribeStatus;
  method: NativeUnsubscribeMethod;
  url?: string;
  detail: string;
}

export interface NativeUnsubscribeBatchResult {
  completed: number;
  failed: number;
  total_attempted: number;
  bytes_freed: number;
  unsubscribe_results: NativeUnsubscribeThreadResult[];
}

export interface ListUnsubscribeInfo {
  oneClickUrl?: string;
  httpsUrls: string[];
  mailtos: string[];
  oneClick: boolean;
}

export type MessageHeaders = Record<string, unknown>;

const ANGLE_URI = /<([^>]+)>/g;
const ONE_CLICK = /List-Unsubscribe\s*=\s*One-Click/i;

/**
 * Read one header case-insensitively. James maps `header:<name>:asText` onto
 * the detail.headers object, while fakes and other adapters may use the bare
 * RFC header name; accepting both keeps the parser adapter-agnostic.
 */
function headerValue(headers: MessageHeaders | null | undefined, name: string): string | null {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized !== wanted && normalized !== `header:${wanted}:astext`) continue;
    if (Array.isArray(raw)) {
      const values = raw.filter((value): value is string => typeof value === 'string');
      return values.length ? values.join(', ') : null;
    }
    return typeof raw === 'string' && raw.trim() ? raw : null;
  }
  return null;
}

export function hasListUnsubscribeHeader(headers: MessageHeaders | null | undefined): boolean {
  return headerValue(headers, 'List-Unsubscribe') !== null;
}

/**
 * Mirror cleaner-engine/cleanup/unsubscribe.py's RFC 2369/RFC 8058 parsing:
 * angle-bracket URIs are extracted in order, a bare value is treated as one
 * URI, and the Post header enables one-click only when its token is present.
 * Native execution intentionally exposes only HTTPS for automatic POSTs.
 */
export function parseListUnsubscribe(
  headers: MessageHeaders | null | undefined,
): ListUnsubscribeInfo {
  const value = headerValue(headers, 'List-Unsubscribe');
  const post = headerValue(headers, 'List-Unsubscribe-Post');
  const uris = value
    ? [...value.matchAll(ANGLE_URI)].map((match) => match[1].trim()).filter(Boolean)
    : [];
  const normalizedUris = uris.length ? uris : value?.trim() ? [value.trim()] : [];
  const httpsUrls = normalizedUris.filter((uri) => uri.toLowerCase().startsWith('https:'));
  const mailtos = normalizedUris.filter((uri) => uri.toLowerCase().startsWith('mailto:'));
  const oneClick = post ? ONE_CLICK.test(post) : false;
  const oneClickUrl = oneClick ? httpsUrls[0] : undefined;

  return {
    ...(oneClickUrl ? { oneClickUrl } : {}),
    httpsUrls,
    mailtos,
    oneClick,
  };
}

function messageOrder(details: StalwartMessageDetail[]): StalwartMessageDetail[] {
  return details
    .map((detail, index) => ({ detail, index, time: Date.parse(detail.sentAt ?? '') }))
    .sort((a, b) => {
      const aValid = Number.isFinite(a.time);
      const bValid = Number.isFinite(b.time);
      if (aValid && bValid && a.time !== b.time) return b.time - a.time;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return b.index - a.index;
    })
    .map(({ detail }) => detail);
}

function senderLabel(detail: StalwartMessageDetail): string | null {
  if (!detail.from) return null;
  return detail.from.name ? `${detail.from.name} <${detail.from.address}>` : detail.from.address;
}

/** Pick the newest actionable List-Unsubscribe target in a native thread. */
export function targetFromNativeThread(
  mailbox: string,
  threadId: string,
  details: StalwartMessageDetail[],
  rationale: string,
): NativeUnsubscribeTarget | null {
  for (const detail of messageOrder(details)) {
    const parsed = parseListUnsubscribe(detail.headers);
    const oneClickUrl = parsed.oneClickUrl;
    const mailto = oneClickUrl ? undefined : parsed.mailtos[0];
    if (!oneClickUrl && !mailto) continue;
    return {
      thread_id: threadId,
      message_id: detail.id,
      mailbox,
      sender: senderLabel(detail),
      subject: detail.subject,
      ...(oneClickUrl ? { one_click_url: oneClickUrl } : { mailto }),
      rationale,
    };
  }
  return null;
}

/**
 * Resolve only targets explicitly advertised by a native message. A missing
 * detail, missing header, or unsupported header is a skipped thread; no target
 * is guessed from the sender, subject, or body.
 */
export async function resolveNativeUnsubscribeTargets(
  mailboxes: readonly { emailAddress: string }[],
  threadIds: string[],
  getThreadDetail: (mailbox: string, threadId: string) => Promise<StalwartMessageDetail[]>,
  rationale: string,
): Promise<NativeUnsubscribeTargetResolution> {
  const ids = Array.from(new Set(threadIds.map((id) => String(id).trim()).filter(Boolean))).slice(
    0,
    50,
  );
  const targets: NativeUnsubscribeTarget[] = [];
  const skipped: NativeUnsubscribeSkippedThread[] = [];

  for (const threadId of ids) {
    let found = false;
    let readable = false;
    let hasHeader = false;
    for (const mailbox of mailboxes) {
      let details: StalwartMessageDetail[];
      try {
        details = await getThreadDetail(mailbox.emailAddress, threadId);
      } catch {
        continue;
      }
      if (details.length > 0) readable = true;
      if (details.some((detail) => hasListUnsubscribeHeader(detail.headers))) hasHeader = true;
      const target = targetFromNativeThread(mailbox.emailAddress, threadId, details, rationale);
      if (!target) continue;
      targets.push(target);
      found = true;
      break;
    }
    if (found) continue;
    skipped.push({
      thread_id: threadId,
      reason: !readable
        ? 'could not read native message headers'
        : hasHeader
          ? 'List-Unsubscribe header has no supported one-click or mailto target'
          : 'no List-Unsubscribe header; nothing staged',
    });
  }
  return { targets, skipped };
}

function decodeMailtoPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parse a mailto target using the same defaults as the cleaner engine. */
export function parseMailto(uri: string): { to: string; subject: string; body: string } | null {
  if (!uri.toLowerCase().startsWith('mailto:')) return null;
  const raw = uri.slice('mailto:'.length);
  const separator = raw.indexOf('?');
  const address = decodeMailtoPart(separator === -1 ? raw : raw.slice(0, separator)).trim();
  if (!address) return null;
  const query = separator === -1 ? '' : raw.slice(separator + 1);
  const params = new URLSearchParams(query);
  const subject = decodeMailtoPart(params.get('subject') ?? 'unsubscribe') || 'unsubscribe';
  const body =
    decodeMailtoPart(params.get('body') ?? 'Please unsubscribe me.') || 'Please unsubscribe me.';
  return { to: address, subject, body };
}

function failedResult(
  target: NativeUnsubscribeTarget,
  method: NativeUnsubscribeMethod,
  detail: string,
  url?: string,
): NativeUnsubscribeThreadResult {
  return {
    thread_id: target.thread_id,
    status: 'failed',
    method,
    ...(url ? { url } : {}),
    detail,
  };
}

/**
 * Execute already-approved, already-parsed targets. The sender callback is the
 * existing native outbound lane; the HTTP port is injectable so this function
 * never needs a live network in unit tests.
 */
export async function executeNativeUnsubscribeTargets(
  targets: NativeUnsubscribeTarget[],
  http: NativeUnsubscribeHttpPort | undefined,
  send: (
    mailbox: string,
    request: StalwartSendRequest,
    transactional: boolean,
  ) => Promise<StalwartSendResult>,
): Promise<NativeUnsubscribeBatchResult> {
  const results: NativeUnsubscribeThreadResult[] = [];
  for (const target of targets) {
    if (target.one_click_url) {
      if (!http) {
        results.push(
          failedResult(
            target,
            'one_click',
            'one-click HTTP client is unavailable',
            target.one_click_url,
          ),
        );
        continue;
      }
      let response: NativeUnsubscribeHttpResult;
      try {
        response = await http.postOneClick(target.one_click_url);
      } catch (error) {
        results.push(
          failedResult(
            target,
            'one_click',
            `one-click POST failed: ${(error as Error).message}`,
            target.one_click_url,
          ),
        );
        continue;
      }
      results.push(
        response.accepted
          ? {
              thread_id: target.thread_id,
              status: 'unsubscribed',
              method: 'one_click',
              url: target.one_click_url,
              detail: response.detail,
            }
          : failedResult(target, 'one_click', response.detail, target.one_click_url),
      );
      continue;
    }

    if (target.mailto) {
      const parsed = parseMailto(target.mailto);
      if (!parsed) {
        results.push(failedResult(target, 'mailto', 'mailto URI had no address', target.mailto));
        continue;
      }
      try {
        const response = await send(
          target.mailbox,
          {
            fromAddress: target.mailbox,
            fromName: null,
            toAddress: parsed.to,
            subject: parsed.subject,
            body: parsed.body,
            inReplyToThreadId: null,
          },
          false,
        );
        results.push(
          response.accepted
            ? {
                thread_id: target.thread_id,
                status: 'unsubscribed',
                method: 'mailto',
                url: target.mailto,
                detail: `mailto unsubscribe sent to ${parsed.to}`,
              }
            : failedResult(
                target,
                'mailto',
                `mailto send failed: ${response.reason ?? 'send rejected'}`,
                target.mailto,
              ),
        );
      } catch (error) {
        results.push(
          failedResult(
            target,
            'mailto',
            `mailto send failed: ${(error as Error).message}`,
            target.mailto,
          ),
        );
      }
      continue;
    }

    results.push(failedResult(target, 'none', 'no approved unsubscribe target', undefined));
  }

  return {
    completed: results.filter((result) => result.status === 'unsubscribed').length,
    failed: results.filter((result) => result.status === 'failed').length,
    total_attempted: results.length,
    bytes_freed: 0,
    unsubscribe_results: results,
  };
}
