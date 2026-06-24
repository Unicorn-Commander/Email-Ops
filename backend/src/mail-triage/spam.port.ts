/**
 * SpamPort — the app-layer seam to the mail engine's inbound spam classifier.
 *
 * The ENGINE (rspamd / SpamAssassin behind Stalwart or James) is the real spam
 * gate: RBL/DNSBL lookups, Bayesian scoring, greylisting, thresholds. This port
 * is how Email-Ops (the app) ASKS the engine for a verdict and TEACHES it back
 * (report spam / not-spam for Bayesian training + feedback loops). It is dormant
 * until the engine is wired — `DormantSpamPort` returns an honest null verdict so
 * nothing is fabricated while the engine is asleep. When the engine lands, a
 * `StalwartSpamPort` (or similar) implements this and `classifyInbound` lights up
 * with zero further wiring.
 *
 * Mirrors the StalwartPort dormant-seam convention used across Email-Ops.
 */

import { Injectable, Logger } from '@nestjs/common';

/** What the engine is asked to classify (a received message). */
export interface SpamClassifyInput {
  fromAddress: string | null;
  subject?: string | null;
  body?: string | null;
  /** Raw headers, when the engine path can supply them (Authentication-Results, etc.). */
  headers?: Record<string, string>;
}

/** The engine's verdict. `score`/`verdict` are null when no engine is wired. */
export interface SpamVerdict {
  /** The engine's numeric spam score (rspamd/SA scale); null when unknown. */
  score: number | null;
  /** Normalized verdict; null when no engine produced one. */
  verdict: 'clean' | 'spam' | 'unsure' | null;
}

/** What the app reports back to the engine for learning / feedback loops. */
export interface SpamReportInput {
  threadId: string;
  fromAddress: string | null;
}

export abstract class SpamPort {
  /** True only when a real engine classifier is configured + reachable. */
  abstract isConfigured(): boolean;
  /** Ask the engine to classify a received message. */
  abstract classify(input: SpamClassifyInput): Promise<SpamVerdict>;
  /** Teach the engine "this was spam" (Bayesian learn + FBL). */
  abstract reportSpam(input: SpamReportInput): Promise<void>;
  /** Teach the engine "this was NOT spam" (false-positive correction). */
  abstract reportHam(input: SpamReportInput): Promise<void>;
}

/**
 * The default, dormant implementation: no engine wired. Honest — it never
 * fabricates a score, and learning calls are no-ops (the engine isn't there to
 * teach). Swapped for a real adapter when the mail engine is stood up.
 */
@Injectable()
export class DormantSpamPort extends SpamPort {
  private readonly logger = new Logger(DormantSpamPort.name);

  isConfigured(): boolean {
    return false;
  }

  async classify(): Promise<SpamVerdict> {
    return { score: null, verdict: null };
  }

  async reportSpam(input: SpamReportInput): Promise<void> {
    this.logger.debug(`reportSpam noop (engine dormant): thread=${input.threadId}`);
  }

  async reportHam(input: SpamReportInput): Promise<void> {
    this.logger.debug(`reportHam noop (engine dormant): thread=${input.threadId}`);
  }
}
