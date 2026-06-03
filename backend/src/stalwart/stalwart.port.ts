/**
 * The Stalwart mail-engine PORT.
 *
 * An abstract class used as a DI token + interface. The Email-Ops service layer
 * depends ONLY on this port, never on the concrete client — the same
 * federate-the-engine seam the suite uses everywhere (ContactOpsPort /
 * AccountingOpsPort / EmailOpsPort on the cockpit side). It gives:
 *
 *   1. The mail engine (Stalwart IMAP/JMAP + the Postmark transactional lane) is
 *      MOCKABLE in tests via a fake StalwartPort — Email-Ops' SoR + agent-inbox
 *      logic is proven without a live mail server.
 *   2. The transport (JMAP/IMAP/SMTP today; a different engine later) is
 *      swappable without touching the message/thread/agent-inbox logic.
 *
 * DEGRADE-CLEAN (binding, brief): when the STALWART_* config is unset,
 * `isConfigured()` is false. READS return [] / null and SENDS return a clean
 * `accepted:false` (lane=null) — Email-Ops never throws because the mail engine
 * isn't wired (verification, or any node where Stalwart isn't reachable). The
 * SoR write still happens (the message row + agent-inbox row are recorded); only
 * the engine hand-off degrades, so a draft can always be staged and a send is
 * recorded as FAILED rather than 500-ing.
 */

import {
  StalwartMessage,
  StalwartSendRequest,
  StalwartSendResult,
  StalwartThread,
} from './stalwart.types';

export abstract class StalwartPort {
  /**
   * Is a Stalwart mail engine configured at all (STALWART_JMAP_URL or
   * STALWART_IMAP_HOST set)? When false, reads return empty and sends record
   * FAILED without an engine call. Pure/synchronous so the service can branch
   * before any I/O.
   */
  abstract isConfigured(): boolean;

  /**
   * List mailbox THREADS that involve `address` (the contact's deliverable
   * address) in the given mailbox. Read-only. Returns [] when not configured /
   * unknown / the call fails (degrade-clean).
   */
  abstract listThreads(mailbox: string, address: string): Promise<StalwartThread[]>;

  /**
   * List the MESSAGES in one thread (bodies as previews only). Read-only.
   * Returns [] when not configured / unknown / the call fails.
   */
  abstract listMessages(mailbox: string, threadId: string): Promise<StalwartMessage[]>;

  /**
   * Hand an outbound message to the mail engine for delivery (the SEND lane).
   * Transactional sends route via Postmark; the rest via Stalwart SMTP/JMAP.
   * Returns `accepted:false` (lane=null) when not configured or on a transport
   * failure — never throws.
   */
  abstract send(
    mailbox: string,
    request: StalwartSendRequest,
    transactional: boolean,
  ): Promise<StalwartSendResult>;
}
