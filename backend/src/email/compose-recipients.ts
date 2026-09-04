/**
 * Shared compose recipient resolution for MCP + REST compose_email.
 *
 * Validates address lists (REST DTO parity: ≤50, email-shaped), enforces
 * to_address vs to_addresses consistency, dedupes, rejects an address that
 * would be both visible (To/Cc) and Bcc, and derives Outlook-style Reply-all
 * from the latest message in a thread.
 */

import { BadRequestException } from '@nestjs/common';
import { normalizeAddress } from './autonomy';

export const MAX_COMPOSE_RECIPIENTS_PER_FIELD = 50;

/** Light address shape check — same family as mail.controller ADDRESS_RE. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ComposeRecipientInput {
  toAddress?: string | null;
  toAddresses?: string[] | null;
  cc?: string[] | null;
  bcc?: string[] | null;
}

export interface ResolvedComposeRecipients {
  toAddress: string;
  toAddresses: string[];
  cc: string[];
  bcc: string[];
}

export interface ReplyAllSource {
  from?: string | null;
  to: string[];
  cc: string[];
  selfAddress: string;
}

export interface RecipientBuckets {
  to: string[];
  cc: string[];
  bcc: string[];
}

/** Unwrap `Name <addr>` and return the bare address with original casing. */
export function bareAddress(raw: string): string {
  const trimmed = (raw ?? '').trim();
  const angled = trimmed.match(/<([^<>]+)>\s*$/);
  return (angled ? angled[1] : trimmed).trim();
}

export function dedupeAddresses(addrs: string[], exclude: string[] = []): string[] {
  const skip = new Set(exclude.map((a) => normalizeAddress(a)).filter(Boolean));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of addrs) {
    const bare = bareAddress(raw);
    if (!bare) continue;
    const key = normalizeAddress(bare);
    if (!key || skip.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(bare);
  }
  return out;
}

function splitMaybeComma(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanList(values: string[] | null | undefined): string[] {
  return dedupeAddresses(values ?? []);
}

export function assertEmailList(label: string, addrs: string[]): void {
  if (addrs.length > MAX_COMPOSE_RECIPIENTS_PER_FIELD) {
    throw new BadRequestException(
      `${label} accepts at most ${MAX_COMPOSE_RECIPIENTS_PER_FIELD} addresses.`,
    );
  }
  for (const a of addrs) {
    if (!ADDRESS_RE.test(a)) {
      throw new BadRequestException(`${label} contains an invalid email address: ${a}`);
    }
  }
}

/**
 * Outlook-matching Reply-all (same rules as the mail client's deriveReplyAll):
 * To = original From (if not self) else the first other recipient; Cc = the
 * remaining To+Cc minus self and minus To. Bcc is never derived.
 */
export function deriveReplyAll(source: ReplyAllSource): { to: string[]; cc: string[] } {
  const self = source.selfAddress ? [source.selfAddress] : [];
  const from = bareAddress(source.from ?? '');
  const fromIsSelf =
    !!from &&
    !!source.selfAddress &&
    normalizeAddress(from) === normalizeAddress(source.selfAddress);
  const others = dedupeAddresses([...source.to, ...source.cc], self);
  const to = !fromIsSelf && from ? [from] : others.slice(0, 1);
  const cc = dedupeAddresses(others, to);
  return { to: dedupeAddresses(to), cc };
}

/**
 * Parse the caller-supplied To/Cc/Bcc. Does NOT require a To (reply_all may
 * fill it). Rejects to_address vs to_addresses disagreement.
 */
export function parseExplicitRecipients(input: ComposeRecipientInput): RecipientBuckets {
  const fromSingle = input.toAddress?.trim() ? splitMaybeComma(input.toAddress) : [];
  const fromList = cleanList(input.toAddresses);
  if (fromSingle.length && fromList.length) {
    if (normalizeAddress(fromSingle[0]) !== normalizeAddress(fromList[0])) {
      throw new BadRequestException(
        'to_address must be the first entry of to_addresses when both are provided.',
      );
    }
  }
  const to = fromList.length ? fromList : cleanList(fromSingle);
  const cc = cleanList(input.cc);
  const bcc = cleanList(input.bcc);
  assertEmailList('to', to);
  assertEmailList('cc', cc);
  assertEmailList('bcc', bcc);
  return finalizeBuckets(to, cc, bcc);
}

/** Derived reply-all set, then any explicit to/cc/bcc merged on top. */
export function mergeReplyAll(derived: { to: string[]; cc: string[] }, explicit: RecipientBuckets): RecipientBuckets {
  const to = dedupeAddresses([...derived.to, ...explicit.to]);
  const cc = dedupeAddresses([...derived.cc, ...explicit.cc], to);
  const bcc = cleanList(explicit.bcc);
  assertEmailList('to', to);
  assertEmailList('cc', cc);
  assertEmailList('bcc', bcc);
  return finalizeBuckets(to, cc, bcc);
}

export function toResolved(buckets: RecipientBuckets): ResolvedComposeRecipients {
  if (!buckets.to.length) {
    throw new BadRequestException(
      'compose_email needs at least one To recipient (to_address, to_addresses, or reply_all).',
    );
  }
  return {
    toAddress: buckets.to[0],
    toAddresses: buckets.to,
    cc: buckets.cc,
    bcc: buckets.bcc,
  };
}

function finalizeBuckets(to: string[], cc: string[], bcc: string[]): RecipientBuckets {
  const toKeys = new Set(to.map((a) => normalizeAddress(a)));
  const ccDeduped = cc.filter((a) => !toKeys.has(normalizeAddress(a)));
  const visible = new Set([...to, ...ccDeduped].map((a) => normalizeAddress(a)));
  for (const b of bcc) {
    if (visible.has(normalizeAddress(b))) {
      throw new BadRequestException(`Address ${b} cannot appear in both To/Cc and Bcc.`);
    }
  }
  return { to, cc: ccDeduped, bcc };
}
