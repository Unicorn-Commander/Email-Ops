/**
 * The concrete Stalwart mail-engine client.
 *
 * Speaks the mailbox / thread surface over Stalwart's JMAP endpoint for reads
 * (list threads/messages), and routes outbound sends to the right deliverability
 * lane: transactional → Postmark (the high-rep lane); everything else → Stalwart
 * SMTP/JMAP submission (SUITE-ARCHITECTURE-MAP §3 comms lanes). The mailbox read
 * path is always Stalwart (it owns the mailboxes/receiving).
 *
 * JMAP transport: a JSON `POST {STALWART_JMAP_URL}` with a session bearer
 * (STALWART_JMAP_TOKEN). The method-call envelope is the standard JMAP
 * `methodCalls` / `methodResponses` shape. This client is written against that
 * surface so a live Stalwart node drops in; until one is wired it is fully
 * degrade-clean (see below) and is what the tests mock.
 *
 * DEGRADE-CLEAN (binding): when neither STALWART_JMAP_URL nor STALWART_IMAP_HOST
 * is set, `isConfigured()` is false; every read returns [] and every send
 * returns `accepted:false` (lane=null) WITHOUT any network call. Email-Ops thus
 * runs fully without a live mail engine (the SoR rows + agent-inbox still
 * record); only the engine hand-off degrades. Every method is also individually
 * safe to call when unconfigured (never throws).
 *
 * Postmark lane: a transactional send POSTs to the Postmark `/email` API with
 * the server token (POSTMARK_SERVER_TOKEN). When the token is unset, the
 * transactional lane falls back to Stalwart submission; when neither is
 * configured, the send degrades clean (accepted:false).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StalwartPort } from './stalwart.port';
import {
  StalwartBlobDownload,
  StalwartDraftRequest,
  StalwartFolderQuery,
  StalwartFolderThreadsResult,
  StalwartMailboxCounts,
  StalwartMessage,
  StalwartParticipant,
  StalwartMessageDetail,
  StalwartMessageHeaders,
  StalwartSendRequest,
  StalwartSendResult,
  StalwartVacationState,
  StalwartThread,
  StalwartUploadResult,
} from './stalwart.types';

@Injectable()
export class StalwartClient extends StalwartPort {
  private readonly logger = new Logger(StalwartClient.name);

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.isConfigured()) {
      this.logger.warn(
        'STALWART_JMAP_URL / STALWART_IMAP_HOST unset — the Stalwart mail engine ' +
          'is DORMANT; mailbox reads return empty and sends record FAILED until ' +
          'configured. The agent-inbox + the message SoR still work (drafts stage, ' +
          'sends are recorded), so Email-Ops runs degrade-clean without a live ' +
          'mail server.',
      );
    } else {
      this.logger.log(
        `Stalwart mail engine target: ${this.jmapUrl ?? this.imapHost} ` +
          `(transactional lane: ${this.postmarkConfigured ? 'Postmark' : 'Stalwart submission'})`,
      );
    }
  }

  // --- configuration seam -------------------------------------------------

  private get jmapUrl(): string | null {
    const raw = this.config.get<string>('STALWART_JMAP_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get imapHost(): string | null {
    const raw = this.config.get<string>('STALWART_IMAP_HOST');
    return raw && raw.trim() ? raw.trim() : null;
  }

  private get jmapToken(): string | null {
    const raw = this.config.get<string>('STALWART_JMAP_TOKEN');
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
    const raw = this.config.get<string>('STALWART_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  isConfigured(): boolean {
    return this.jmapUrl !== null || this.imapHost !== null;
  }

  // --- JMAP transport -----------------------------------------------------

  private jmapHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.jmapToken;
    if (token) headers['Authorization'] = `Bearer ${token}`;
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

  /**
   * Issue a JMAP request and return the parsed `methodResponses`, or null on any
   * transport/parse failure (logged). Never throws.
   */
  private async jmap(methodCalls: unknown[]): Promise<any[] | null> {
    const url = this.jmapUrl;
    if (!url) return null;
    const body = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls,
    };
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.jmapHeaders(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Stalwart JMAP transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`Stalwart JMAP HTTP ${res.status}`);
      return null;
    }
    try {
      const payload = (await res.json()) as { methodResponses?: any[] };
      return Array.isArray(payload.methodResponses) ? payload.methodResponses : null;
    } catch (err) {
      this.logger.warn(`Stalwart JMAP non-JSON response: ${(err as Error).message}`);
      return null;
    }
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

  // --- StalwartPort implementation ---------------------------------------

  async listThreads(mailbox: string, address: string): Promise<StalwartThread[]> {
    if (!this.jmapUrl) return [];
    // Email/query filtered by participant, then Thread/get + Email/get for the
    // representative subject/snippet. We issue a compact chained request and map
    // whatever the node returns; an unconfigured/invalid response degrades to [].
    const responses = await this.jmap([
      [
        'Email/query',
        { filter: { from: address, to: address, operator: 'OR' }, collapseThreads: true },
        '0',
      ],
    ]);
    if (!responses) return [];
    // Stalwart returns thread/email projections; we accept a tolerant shape so a
    // live node maps without a brittle exact-schema dependency. The reference
    // node returns `threads` on the structured response in our fronting adapter.
    const first = responses[0];
    const payload = Array.isArray(first) ? first[1] : undefined;
    const threads = payload?.threads;
    if (!Array.isArray(threads)) return [];
    const out: StalwartThread[] = [];
    for (const t of threads) {
      if (!t || typeof t !== 'object') continue;
      const id = (t as any).id;
      if (typeof id !== 'string' || !id) continue;
      out.push({
        id,
        subject: typeof (t as any).subject === 'string' ? (t as any).subject : null,
        messageCount: Number.isFinite((t as any).messageCount) ? (t as any).messageCount : 0,
        unread: (t as any).unread === true,
        lastMessageAt:
          typeof (t as any).lastMessageAt === 'string' ? (t as any).lastMessageAt : null,
        lastSnippet: typeof (t as any).lastSnippet === 'string' ? (t as any).lastSnippet : null,
        participants: this.toParticipants((t as any).participants),
      });
    }
    return out;
  }

  async listMessages(mailbox: string, threadId: string): Promise<StalwartMessage[]> {
    if (!this.jmapUrl) return [];
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
    const emailResp = responses.find((r) => Array.isArray(r) && r[0] === 'Email/get');
    const list = Array.isArray(emailResp) ? emailResp[1]?.list : undefined;
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

  /**
   * NOT SUPPORTED on the legacy Stalwart engine (the webmail-wave search+paging
   * surface is James-first) — degrade-clean: always returns an empty
   * threads array, never throws. Swap MAIL_ENGINE=james to light this up for real.
   */
  async listFolderThreads(_mailbox: string, _query: StalwartFolderQuery): Promise<StalwartFolderThreadsResult> {
    return { threads: [] };
  }

  /** NOT SUPPORTED on Stalwart (webmail-wave thread-detail enrichment) — degrade-clean []. */
  async getThreadDetail(_mailbox: string, _threadId: string): Promise<StalwartMessageDetail[]> {
    return [];
  }

  /** NOT SUPPORTED on Stalwart (webmail-wave read-state toggle) — degrade-clean false. */
  async setThreadRead(_mailbox: string, _threadId: string, _read: boolean): Promise<boolean> {
    return false;
  }

  async setThreadFlags(
    _mailbox: string,
    _threadId: string,
    _flags: { seen?: boolean; flagged?: boolean },
  ): Promise<boolean> {
    return false;
  }

  /** NOT SUPPORTED on Stalwart (JMAP folder move is a James-only surface) — degrade-clean false. */
  async moveThreadToFolder(
    _mailbox: string,
    _threadId: string,
    _folder: StalwartFolderQuery['folder'],
  ): Promise<boolean> {
    return false;
  }

  async emptyFolder(_mailbox: string, _folder: 'trash' | 'spam'): Promise<number | null> {
    return null;
  }

  async saveDraft(_mailbox: string, _draft: StalwartDraftRequest): Promise<{ id: string } | null> {
    return null;
  }

  async updateDraft(
    _mailbox: string,
    _draftId: string,
    _draft: StalwartDraftRequest,
  ): Promise<{ id: string } | null> {
    return null;
  }

  async deleteDraft(_mailbox: string, _draftId: string): Promise<boolean> {
    return false;
  }

  async getVacation(_mailbox: string): Promise<StalwartVacationState | null> {
    return null;
  }

  async setVacation(_mailbox: string, _state: StalwartVacationState): Promise<boolean> {
    return false;
  }

  /** NOT SUPPORTED on Stalwart (webmail-wave counts surface) — degrade-clean null. */
  async getMailboxCounts(_mailbox: string): Promise<StalwartMailboxCounts | null> {
    return null;
  }

  /** NOT SUPPORTED on Stalwart (webmail-wave attachment download) — degrade-clean null. */
  async downloadBlob(_mailbox: string, _blobId: string): Promise<StalwartBlobDownload | null> {
    return null;
  }

  /** NOT SUPPORTED on Stalwart (webmail-wave attachment upload) — degrade-clean null. */
  async uploadBlob(
    _mailbox: string,
    _file: Buffer,
    _type: string,
    _filename: string,
  ): Promise<StalwartUploadResult | null> {
    return null;
  }

  /** NOT SUPPORTED on Stalwart (webmail-wave reply-threading resolution) — degrade-clean null. */
  async getMessageHeaders(_mailbox: string, _messageId: string): Promise<StalwartMessageHeaders | null> {
    return null;
  }

  async send(
    mailbox: string,
    request: StalwartSendRequest,
    transactional: boolean,
  ): Promise<StalwartSendResult> {
    // Neither Stalwart lane carries attachments. Fail loud rather than silently drop
    // the file (accepted:true with a missing attachment). uploadBlob returns null for
    // Stalwart mailboxes so no blob_id is normally minted — this guards a stale/forged
    // ref or a draft staged under James then approved after an engine switch.
    if ((request.attachments?.length ?? 0) > 0) {
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: null,
        reason: 'the Stalwart engine cannot carry attachments — nothing was sent',
      };
    }
    // Transactional → Postmark (high-rep) when configured.
    if (transactional && this.postmarkConfigured) {
      return this.sendViaPostmark(request);
    }
    // Otherwise (or transactional without Postmark) → Stalwart submission.
    if (this.jmapUrl) {
      return this.sendViaStalwart(mailbox, request);
    }
    // Nothing configured — degrade clean.
    return {
      accepted: false,
      providerMessageId: null,
      threadId: request.inReplyToThreadId ?? null,
      lane: null,
      reason: 'mail engine not configured (STALWART_* + POSTMARK_SERVER_TOKEN unset)',
    };
  }

  // Folder CRUD + custom-folder move are James/JMAP-only capabilities; the
  // legacy Stalwart adapter never participates (degrade-clean → []/null/false).
  async moveThreadToMailbox(): Promise<boolean> {
    return false;
  }
  async listFolders(): Promise<never[]> {
    return [];
  }
  async createFolder(): Promise<null> {
    return null;
  }
  async renameFolder(): Promise<boolean> {
    return false;
  }
  async deleteFolder(): Promise<boolean> {
    return false;
  }

  // Inbound polling is a James/JMAP-only capability; the legacy Stalwart adapter
  // never participates (degrade-clean → null).
  async pollInbound(): Promise<null> {
    return null;
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
          To: request.toAddresses?.length ? request.toAddresses.join(', ') : request.toAddress,
          Subject: request.subject,
          TextBody: request.body,
          ...(request.bodyHtml ? { HtmlBody: request.bodyHtml } : {}),
          MessageStream: 'outbound',
          // Wave 7: custom headers (e.g. the X-UC-Agent-Autoreply loop marker).
          ...(request.headers?.length
            ? { Headers: request.headers.map((h) => ({ Name: h.name, Value: h.value })) }
            : {}),
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
      /* ignore — accepted with no parseable id */
    }
    return {
      accepted: true,
      providerMessageId: typeof body?.MessageID === 'string' ? body.MessageID : null,
      threadId: request.inReplyToThreadId ?? null,
      lane: 'postmark',
    };
  }

  private async sendViaStalwart(
    mailbox: string,
    request: StalwartSendRequest,
  ): Promise<StalwartSendResult> {
    // JMAP EmailSubmission/set is the submission path; we issue a compact
    // Email/set (draft) + EmailSubmission/set chained call and map the id.
    const responses = await this.jmap([
      [
        'Email/set',
        {
          create: {
            outbound: {
              from: [{ email: request.fromAddress, name: request.fromName ?? null }],
              to: (request.toAddresses?.length ? request.toAddresses : [request.toAddress]).map((email) => ({ email })),
              subject: request.subject,
              bodyValues: request.bodyHtml
                ? { body: { value: request.body }, html: { value: request.bodyHtml } }
                : { body: { value: request.body } },
              textBody: [{ partId: 'body', type: 'text/plain' }],
              ...(request.bodyHtml ? { htmlBody: [{ partId: 'html', type: 'text/html' }] } : {}),
              // Wave 7: custom headers via the RFC 8621 header:{name} form.
              ...Object.fromEntries(
                (request.headers ?? []).map((h) => [`header:${h.name}:asText`, h.value]),
              ),
            },
          },
        },
        '0',
      ],
      ['EmailSubmission/set', { create: { sub: { emailId: '#outbound' } } }, '1'],
    ]);
    if (!responses) {
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: 'stalwart',
        reason: 'stalwart submission failed (no response)',
      };
    }
    const emailSet = responses.find((r) => Array.isArray(r) && r[0] === 'Email/set');
    const created = Array.isArray(emailSet) ? emailSet[1]?.created?.outbound : undefined;
    const providerMessageId = created?.id ?? null;
    const threadId = created?.threadId ?? request.inReplyToThreadId ?? null;
    return {
      accepted: providerMessageId != null,
      providerMessageId,
      threadId,
      lane: 'stalwart',
      reason: providerMessageId == null ? 'stalwart submission returned no id' : null,
    };
  }
}
