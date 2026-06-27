/**
 * JamesClient — the Apache James implementation of the mail-engine data plane
 * (the same StalwartPort the service layer depends on).
 *
 * James is JMAP-native (RFC 8620/8621), so this is a close cousin of
 * StalwartClient: the transport is the identical `methodCalls` / `methodResponses`
 * envelope. The differences are (1) the JMAP endpoint + auth (James takes Basic
 * or a Bearer/OIDC token), and (2) the reads use STANDARD JMAP queries
 * (Email/query → Email/get → Thread/get) rather than Stalwart's custom `threads`
 * projection.
 *
 * Outbound: transactional sends route to Postmark (the high-rep lane), exactly
 * as on Stalwart. Non-transactional sends also go via Postmark when it is
 * configured — Postmark is the only SPF-authorised egress for these domains
 * (SPF = include:spf.mtasv.net), so routing James' app-sends through it keeps
 * DMARC/SPF aligned. When Postmark is unset, a best-effort JMAP EmailSubmission
 * is attempted against James. (A real IMAP/SMTP client still submits to James
 * directly; James relays out via its Postmark smarthost — an engine config, not
 * app logic.)
 *
 * DEGRADE-CLEAN (binding, identical to StalwartPort): when JAMES_JMAP_URL is
 * unset, isConfigured() is false; reads return [] and sends return
 * accepted:false (lane=null) WITHOUT any network call, and nothing throws.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StalwartPort } from './stalwart.port';
import {
  StalwartMessage,
  StalwartParticipant,
  StalwartSendRequest,
  StalwartSendResult,
  StalwartThread,
} from './stalwart.types';

@Injectable()
export class JamesClient extends StalwartPort {
  private readonly logger = new Logger(JamesClient.name);

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.isConfigured()) {
      this.logger.warn(
        'JAMES_JMAP_URL unset — the James mail engine is DORMANT; mailbox reads ' +
          'return empty and sends record FAILED until configured (degrade-clean).',
      );
    } else {
      this.logger.log(
        `James mail engine target: ${this.jmapUrl} ` +
          `(transactional lane: ${this.postmarkConfigured ? 'Postmark' : 'James submission'})`,
      );
    }
  }

  // --- configuration seam -------------------------------------------------

  private get jmapUrl(): string | null {
    const raw = this.config.get<string>('JAMES_JMAP_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  /** Basic-auth credentials "user:pass" (James' default JMAP auth). */
  private get basic(): string | null {
    const raw = this.config.get<string>('JAMES_JMAP_BASIC');
    return raw && raw.trim() ? raw.trim() : null;
  }

  /** A Bearer/OIDC token (preferred when James federates auth to Keycloak). */
  private get bearer(): string | null {
    const raw = this.config.get<string>('JAMES_JMAP_BEARER');
    return raw && raw.trim() ? raw.trim() : null;
  }

  private get postmarkToken(): string | null {
    const raw = this.config.get<string>('POSTMARK_SERVER_TOKEN');
    return raw && raw.trim() ? raw.trim() : null;
  }

  private get postmarkConfigured(): boolean {
    return this.postmarkToken !== null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('JAMES_TIMEOUT_MS') ?? this.config.get<string>('STALWART_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  isConfigured(): boolean {
    return this.jmapUrl !== null;
  }

  // --- JMAP transport -----------------------------------------------------

  private jmapHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.bearer) headers['Authorization'] = `Bearer ${this.bearer}`;
    else if (this.basic) headers['Authorization'] = `Basic ${Buffer.from(this.basic).toString('base64')}`;
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Issue a JMAP request; return parsed methodResponses or null on any failure (never throws). */
  private async jmap(methodCalls: unknown[]): Promise<any[] | null> {
    const url = this.jmapUrl;
    if (!url) return null;
    const body = { using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls };
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.jmapHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`James JMAP transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`James JMAP HTTP ${res.status}`);
      return null;
    }
    try {
      const payload = (await res.json()) as { methodResponses?: any[] };
      return Array.isArray(payload.methodResponses) ? payload.methodResponses : null;
    } catch (err) {
      this.logger.warn(`James JMAP non-JSON response: ${(err as Error).message}`);
      return null;
    }
  }

  private named(responses: any[], method: string): any | undefined {
    const r = responses.find((x) => Array.isArray(x) && x[0] === method);
    return Array.isArray(r) ? r[1] : undefined;
  }

  // --- mapping ------------------------------------------------------------

  private toParticipant(raw: unknown): StalwartParticipant | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const address = r['email'] ?? r['address'];
    if (typeof address !== 'string' || !address) return null;
    return { address, name: typeof r['name'] === 'string' ? (r['name'] as string) : null };
  }

  private toParticipants(raw: unknown): StalwartParticipant[] {
    if (!Array.isArray(raw)) return [];
    const out: StalwartParticipant[] = [];
    for (const p of raw) {
      const parsed = this.toParticipant(p);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  // --- StalwartPort implementation ----------------------------------------

  async listThreads(mailbox: string, address: string): Promise<StalwartThread[]> {
    if (!this.jmapUrl) return [];
    // Standard JMAP: query collapsed-by-thread (one representative email per
    // thread) filtered by participant, fetch those emails, and fetch the threads
    // for accurate message counts. Tolerant of missing pieces (degrade to []).
    const responses = await this.jmap([
      [
        'Email/query',
        {
          filter: { operator: 'OR', conditions: [{ from: address }, { to: address }] },
          collapseThreads: true,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: 50,
        },
        '0',
      ],
      [
        'Email/get',
        {
          '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
          properties: ['id', 'threadId', 'subject', 'from', 'to', 'receivedAt', 'preview', 'keywords'],
        },
        '1',
      ],
      ['Thread/get', { '#ids': { resultOf: '1', name: 'Email/get', path: '/list/*/threadId' } }, '2'],
    ]);
    if (!responses) return [];
    const emails = this.named(responses, 'Email/get')?.list;
    if (!Array.isArray(emails)) return [];
    const threadList = this.named(responses, 'Thread/get')?.list;
    const countByThread = new Map<string, number>();
    if (Array.isArray(threadList)) {
      for (const t of threadList) {
        const id = (t as any)?.id;
        const ids = (t as any)?.emailIds;
        if (typeof id === 'string' && Array.isArray(ids)) countByThread.set(id, ids.length);
      }
    }
    const out: StalwartThread[] = [];
    for (const m of emails) {
      if (!m || typeof m !== 'object') continue;
      const threadId = (m as any).threadId;
      if (typeof threadId !== 'string' || !threadId) continue;
      const keywords = (m as any).keywords ?? {};
      const participants = [
        ...this.toParticipants((m as any).from),
        ...this.toParticipants((m as any).to),
      ];
      out.push({
        id: threadId,
        subject: typeof (m as any).subject === 'string' ? (m as any).subject : null,
        messageCount: countByThread.get(threadId) ?? 1,
        unread: keywords['$seen'] !== true,
        lastMessageAt: typeof (m as any).receivedAt === 'string' ? (m as any).receivedAt : null,
        lastSnippet: typeof (m as any).preview === 'string' ? (m as any).preview : null,
        participants,
      });
    }
    return out;
  }

  async listMessages(mailbox: string, threadId: string): Promise<StalwartMessage[]> {
    if (!this.jmapUrl) return [];
    // Standard JMAP Thread/get → Email/get chain (portable across JMAP engines).
    const responses = await this.jmap([
      ['Thread/get', { ids: [threadId] }, '0'],
      [
        'Email/get',
        {
          '#ids': { resultOf: '0', name: 'Thread/get', path: '/list/*/emailIds' },
          properties: ['threadId', 'from', 'to', 'subject', 'receivedAt', 'preview', 'keywords'],
        },
        '1',
      ],
    ]);
    if (!responses) return [];
    const list = this.named(responses, 'Email/get')?.list;
    if (!Array.isArray(list)) return [];
    const out: StalwartMessage[] = [];
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const id = (m as any).id;
      if (typeof id !== 'string' || !id) continue;
      const keywords = (m as any).keywords ?? {};
      const direction: StalwartMessage['direction'] = keywords['$draft']
        ? 'draft'
        : keywords['$sent']
          ? 'sent'
          : 'received';
      out.push({
        id,
        threadId: typeof (m as any).threadId === 'string' ? (m as any).threadId : threadId,
        from: this.toParticipant(Array.isArray((m as any).from) ? (m as any).from[0] : null),
        to: this.toParticipants((m as any).to),
        subject: typeof (m as any).subject === 'string' ? (m as any).subject : null,
        sentAt: typeof (m as any).receivedAt === 'string' ? (m as any).receivedAt : null,
        preview: typeof (m as any).preview === 'string' ? (m as any).preview : null,
        direction,
      });
    }
    return out;
  }

  async send(
    mailbox: string,
    request: StalwartSendRequest,
    transactional: boolean,
  ): Promise<StalwartSendResult> {
    // Postmark is the only SPF-authorised egress for these domains, so route
    // through it whenever it is configured (transactional and otherwise). It is
    // also the high-rep lane for transactional mail.
    if (this.postmarkConfigured) {
      return this.sendViaPostmark(request);
    }
    // No Postmark — attempt a best-effort JMAP submission against James.
    if (this.jmapUrl) {
      return this.sendViaJames(request);
    }
    return {
      accepted: false,
      providerMessageId: null,
      threadId: request.inReplyToThreadId ?? null,
      lane: null,
      reason: 'mail engine not configured (JAMES_JMAP_URL + POSTMARK_SERVER_TOKEN unset)',
    };
  }

  private async sendViaPostmark(request: StalwartSendRequest): Promise<StalwartSendResult> {
    const token = this.postmarkToken!;
    const fromHeader = request.fromName
      ? `${request.fromName} <${request.fromAddress}>`
      : request.fromAddress;
    let res: Response;
    try {
      res = await this.fetchWithTimeout('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Postmark-Server-Token': token,
        },
        body: JSON.stringify({
          From: fromHeader,
          To: request.toAddress,
          Subject: request.subject,
          TextBody: request.body,
          MessageStream: 'outbound',
        }),
      });
    } catch (err) {
      this.logger.warn(`Postmark transport error: ${(err as Error).message}`);
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: 'postmark',
        reason: (err as Error).message,
      };
    }
    if (!res.ok) {
      this.logger.warn(`Postmark HTTP ${res.status}`);
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: 'postmark',
        reason: `HTTP ${res.status}`,
      };
    }
    let body: any = {};
    try {
      body = await res.json();
    } catch {
      /* accepted with no parseable id */
    }
    return {
      accepted: true,
      providerMessageId: typeof body?.MessageID === 'string' ? body.MessageID : null,
      threadId: request.inReplyToThreadId ?? null,
      lane: 'postmark',
    };
  }

  private async sendViaJames(request: StalwartSendRequest): Promise<StalwartSendResult> {
    // Best-effort JMAP submission: resolve a sending Identity for the from
    // address, stage the Email, and submit. Degrade-clean on any gap.
    const idResp = await this.jmap([['Identity/get', {}, '0']]);
    const identities = idResp ? this.named(idResp, 'Identity/get')?.list : undefined;
    const identity = Array.isArray(identities)
      ? identities.find((i: any) => i?.email === request.fromAddress) ?? identities[0]
      : undefined;
    if (!identity?.id) {
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: 'james',
        reason: 'no James sending identity for from-address',
      };
    }
    const responses = await this.jmap([
      [
        'Email/set',
        {
          create: {
            outbound: {
              from: [{ email: request.fromAddress, name: request.fromName ?? null }],
              to: [{ email: request.toAddress }],
              subject: request.subject,
              bodyValues: { body: { value: request.body } },
              textBody: [{ partId: 'body', type: 'text/plain' }],
            },
          },
        },
        '0',
      ],
      [
        'EmailSubmission/set',
        { create: { sub: { emailId: '#outbound', identityId: identity.id } } },
        '1',
      ],
    ]);
    if (!responses) {
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: 'james',
        reason: 'james submission failed (no response)',
      };
    }
    const created = this.named(responses, 'Email/set')?.created?.outbound;
    const providerMessageId = created?.id ?? null;
    const threadId = created?.threadId ?? request.inReplyToThreadId ?? null;
    return {
      accepted: providerMessageId != null,
      providerMessageId,
      threadId,
      lane: 'james',
      reason: providerMessageId == null ? 'james submission returned no id' : null,
    };
  }
}
