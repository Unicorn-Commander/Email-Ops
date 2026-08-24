/**
 * mail-routing — the EXPLICIT send/draft lane rule.
 *
 * Before this module the routing decision existed, but only implicitly: it was
 * `mailProvider.handles(mailbox)` reading `MailboxAccount.provider` deep inside
 * `EmailService.callEngine`. That is a real rule, but it is invisible to a caller
 * asking the only question that matters in practice —
 *
 *     "if I compose FROM aaron@magicunicorn.tech, where does it actually go?"
 *
 * The rule, stated once:
 *
 *   1. A registered `MailboxAccount` is the ONLY routing authority. Its
 *      `provider` column decides the lane:
 *        provider = 'microsoft'  -> GRAPH  (Microsoft 365, delegated broker token)
 *        provider = 'gmail'      -> GMAIL  (Gmail API, delegated broker token)
 *        provider = 'stalwart'   -> JAMES  (the sovereign Apache James engine)
 *   2. An address with NO registered mailbox is UNROUTABLE. It is NOT quietly
 *      sent from the workspace default — that is exactly how a cold-outreach mail
 *      meant to leave `@magicunicorn.tech` silently left `@magicunicorn.dev`
 *      instead.
 *   3. Domains are DERIVED from the registered mailboxes, never hardcoded. A
 *      hardcoded `magicunicorn.tech` string would rot the first time a domain
 *      moves between engines; the mailbox row is the single source of truth.
 *
 * Concretely, for this workspace today:
 *   aaron@magicunicorn.tech -> GRAPH   (M365)
 *   aaron@magicunicorn.dev  -> JAMES   (sovereign)
 *   aaron@majiks.studio     -> JAMES   (sovereign)
 *   person5@example.com-> GMAIL
 *
 * This module is pure — no Prisma, no HTTP — so the rule is unit-testable on its
 * own, which is the point.
 */

/** The transport lane a message actually travels. */
export type MailLane = 'graph' | 'gmail' | 'james';

/** The minimum shape routing needs from a MailboxAccount row. */
export interface RoutableMailbox {
  id?: string;
  emailAddress: string;
  provider: string;
  active?: boolean;
}

/** Why an address could not be routed (never guess — say which). */
export type MailRouteFailure = 'no_address' | 'no_registered_mailbox' | 'mailbox_inactive';

export type MailRouteResult =
  | { ok: true; lane: MailLane; mailbox: RoutableMailbox; address: string }
  | { ok: false; reason: MailRouteFailure; address: string };

/** Normalize an address for comparison (case-insensitive, trimmed). */
export function normalizeAddress(address: string | null | undefined): string {
  return (address ?? '').trim().toLowerCase();
}

/** The domain part of an address, or '' when malformed. */
export function domainOf(address: string | null | undefined): string {
  const at = normalizeAddress(address).lastIndexOf('@');
  return at === -1 ? '' : normalizeAddress(address).slice(at + 1);
}

/**
 * The lane a given mailbox row travels. `provider` is the authority; anything
 * unrecognized falls back to the sovereign engine, which is the historical
 * default for every pre-existing row (`provider` defaults to 'stalwart').
 */
export function laneForMailbox(mailbox: Pick<RoutableMailbox, 'provider'>): MailLane {
  switch (mailbox.provider) {
    case 'microsoft':
      return 'graph';
    case 'gmail':
      return 'gmail';
    default:
      return 'james';
  }
}

/** True when this lane is served by an external provider API (not James). */
export function isExternalLane(lane: MailLane): boolean {
  return lane === 'graph' || lane === 'gmail';
}

/**
 * Resolve the lane for a FROM address against the workspace's registered
 * mailboxes. Explicit failure (never a silent fallback to the default mailbox).
 */
export function routeFromAddress(
  address: string | null | undefined,
  mailboxes: RoutableMailbox[],
): MailRouteResult {
  const wanted = normalizeAddress(address);
  if (!wanted) return { ok: false, reason: 'no_address', address: '' };

  const match = mailboxes.find((m) => normalizeAddress(m.emailAddress) === wanted);
  if (!match) return { ok: false, reason: 'no_registered_mailbox', address: wanted };
  if (match.active === false) return { ok: false, reason: 'mailbox_inactive', address: wanted };

  return { ok: true, lane: laneForMailbox(match), mailbox: match, address: wanted };
}

/**
 * A human-readable routing table for the workspace — what `list_mail_domains`
 * could never tell you, because it only ever listed the James domains and so
 * made the M365 domain look unsupported when it was merely served elsewhere.
 */
export function routingTable(
  mailboxes: RoutableMailbox[],
): { address: string; domain: string; lane: MailLane; active: boolean }[] {
  return mailboxes.map((m) => ({
    address: normalizeAddress(m.emailAddress),
    domain: domainOf(m.emailAddress),
    lane: laneForMailbox(m),
    active: m.active !== false,
  }));
}
