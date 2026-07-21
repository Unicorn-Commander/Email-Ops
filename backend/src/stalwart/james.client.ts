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
 * ATTACHMENT-SEND ROUTING DEVIATION (webmail wave, flagged in the wave report):
 * an attachment-bearing send is ALWAYS routed via JMAP EmailSubmission
 * (sendViaJames), even when Postmark is configured — the uploaded blob lives in
 * James' own blob store (keyed by blobId under the sending account), and
 * Postmark's API has no way to reference it directly; re-downloading + base64
 * re-encoding every attachment just to hand it to Postmark would be wasteful and
 * fragile. Plain sends (no attachments) keep preferring Postmark exactly as
 * before. cc/bcc/threading (in-reply-to/references) work on BOTH lanes.
 *
 * DELEGATION-AWARE: the configured principal (hq@) holds James delegated access
 * to the other sovereign mailboxes, so its JMAP Session lists EVERY account it
 * may act on (`session.accounts`, keyed by accountId with `name` = the mailbox
 * address). Account-scoped calls resolve the target mailbox's own accountId by
 * a case-insensitive address match against that list, so reads run against the
 * CORRECT mailbox rather than always the primary principal. An unknown address
 * triggers ONE session re-fetch (a delegation may have been granted since the
 * session was cached), then falls back to the primary accountId — exactly the
 * pre-delegation behavior.
 *
 * DEGRADE-CLEAN (binding, identical to StalwartPort): when JAMES_JMAP_URL is
 * unset, isConfigured() is false; reads return [] and sends return
 * accepted:false (lane=null) WITHOUT any network call, and nothing throws.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StalwartPort } from './stalwart.port';
import { parseSearchQuery, buildJmapFilter } from './search-query';
import {
  StalwartAttachment,
  StalwartBlobDownload,
  StalwartDraftRequest,
  StalwartFolderQuery,
  StalwartFolderThreadsResult,
  StalwartMailFolder,
  StalwartMailboxCounts,
  StalwartMessage,
  StalwartMessageDetail,
  StalwartMessageHeaders,
  StalwartParticipant,
  StalwartSendRequest,
  StalwartSendResult,
  StalwartVacationState,
  StalwartThread,
  StalwartUploadResult,
  InboundPollResult,
} from './stalwart.types';

/** The client mail folder → the JMAP Mailbox `role` it lives under on James. */
const FOLDER_ROLE: Record<StalwartFolderQuery['folder'], string> = {
  inbox: 'inbox',
  archive: 'archive',
  spam: 'junk',
  trash: 'trash',
  sent: 'sent',
  drafts: 'drafts',
};

@Injectable()
export class JamesClient extends StalwartPort {
  private readonly logger = new Logger(JamesClient.name);

  /** Cached JMAP mail accountId for the authenticated principal (resolved once). */
  private accountIdCache: string | null = null;

  /** Lowercased mailbox address → accountId, from `session.accounts` (own + delegated). */
  private accountsByAddress: Map<string, string> | null = null;

  /** Addresses already given their one stale-session re-fetch (don't hammer /session). */
  private readonly refreshedMisses = new Set<string>();

  /** The session's blob download/upload URL templates (RFC 8620 §2), cached with the session. */
  private downloadUrlTemplate: string | null = null;
  private uploadUrlTemplate: string | null = null;

  /** JMAP method families that REQUIRE an accountId argument on James. */
  private static readonly ACCOUNT_SCOPED =
    /^(Email|Mailbox|Thread|EmailSubmission|Identity|SearchSnippet|VacationResponse|Quota)\//;

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

  /** Auth-only headers (no Content-Type) — used for raw blob download/upload. */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.bearer) headers['Authorization'] = `Bearer ${this.bearer}`;
    else if (this.basic) headers['Authorization'] = `Basic ${Buffer.from(this.basic).toString('base64')}`;
    return headers;
  }

  private jmapHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...this.authHeaders() };
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
   * Fetch the JMAP Session resource at {JAMES_JMAP_URL}/session and (re)build
   * ALL session-derived caches: the primary mail accountId, the address→accountId
   * delegation map from `session.accounts` (every account the principal may act
   * on; `name` is the mailbox address), and the blob download/upload URL
   * templates. Degrade-clean: returns null (→ jmap() returns null → reads [],
   * sends best-effort) on any gap, leaving any previously cached session in
   * place.
   */
  private async fetchSession(): Promise<string | null> {
    const base = this.jmapUrl;
    if (!base) return null;
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${base}/session`, {
        method: 'GET',
        headers: this.jmapHeaders(),
      });
    } catch (err) {
      this.logger.warn(`James JMAP session transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`James JMAP session HTTP ${res.status}`);
      return null;
    }
    try {
      const s = (await res.json()) as {
        primaryAccounts?: Record<string, string>;
        accounts?: Record<string, { name?: unknown }>;
        downloadUrl?: unknown;
        uploadUrl?: unknown;
      };
      const id = s?.primaryAccounts?.['urn:ietf:params:jmap:mail'];
      if (typeof id === 'string' && id) {
        this.accountIdCache = id;
        const byAddress = new Map<string, string>();
        if (s.accounts && typeof s.accounts === 'object') {
          for (const [accountId, acct] of Object.entries(s.accounts)) {
            const name = acct?.name;
            if (typeof name === 'string' && name.trim()) {
              byAddress.set(name.trim().toLowerCase(), accountId);
            }
          }
        }
        this.accountsByAddress = byAddress;
        if (typeof s.downloadUrl === 'string' && s.downloadUrl) this.downloadUrlTemplate = s.downloadUrl;
        if (typeof s.uploadUrl === 'string' && s.uploadUrl) this.uploadUrlTemplate = s.uploadUrl;
        return id;
      }
      this.logger.warn('James JMAP session carried no mail account');
      return null;
    } catch (err) {
      this.logger.warn(`James JMAP session non-JSON: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Resolve (and cache) the JMAP mail accountId for the authenticated principal.
   * James REQUIRES an explicit accountId on every account-scoped method call
   * (Stalwart's fronting projection did not), so fetch it once from the Session
   * resource and reuse it.
   */
  private async resolveAccountId(): Promise<string | null> {
    if (this.accountIdCache) return this.accountIdCache;
    return this.fetchSession();
  }

  /**
   * Resolve the accountId an account-scoped call should run under for the given
   * mailbox address: the address's OWN (delegated) account when the session
   * lists it (case-insensitive), else the primary principal — preserving the
   * pre-delegation behavior for any mailbox hq@ cannot (yet) act on. On a map
   * miss, the session is re-fetched ONCE per address (a delegation may have
   * been granted since boot) before falling back.
   */
  private async resolveAccountIdFor(address: string | null): Promise<string | null> {
    const primary = await this.resolveAccountId();
    if (!primary || !address || !address.trim()) return primary;
    const key = address.trim().toLowerCase();
    const hit = this.accountsByAddress?.get(key);
    if (hit) return hit;
    if (!this.refreshedMisses.has(key)) {
      this.refreshedMisses.add(key);
      await this.fetchSession();
      const refreshed = this.accountsByAddress?.get(key);
      if (refreshed) {
        this.refreshedMisses.delete(key);
        return refreshed;
      }
      this.logger.warn(
        `no delegated James account for ${address} — running as the primary principal`,
      );
    }
    return this.accountIdCache ?? primary;
  }

  /** Ensure the blob download/upload URL templates are cached (fetch the session if not). */
  private async ensureBlobTemplates(): Promise<void> {
    if (this.downloadUrlTemplate && this.uploadUrlTemplate) return;
    await this.fetchSession();
  }

  /**
   * Issue a JMAP request; return parsed methodResponses or null on any failure
   * (never throws). `forAddress` names the target mailbox: account-scoped calls
   * run under that mailbox's own (delegated) accountId when the session lists
   * it, else under the primary principal.
   */
  private async jmap(methodCalls: unknown[], forAddress: string | null = null): Promise<any[] | null> {
    const url = this.jmapUrl;
    if (!url) return null;
    const accountId = await this.resolveAccountIdFor(forAddress);
    if (!accountId) return null;
    // James requires an explicit accountId on every account-scoped call; inject
    // it wherever the caller omitted it (result references like #ids are kept).
    const calls = (methodCalls as any[]).map((c) =>
      Array.isArray(c) &&
      typeof c[0] === 'string' &&
      JamesClient.ACCOUNT_SCOPED.test(c[0]) &&
      c[1] &&
      typeof c[1] === 'object' &&
      (c[1] as Record<string, unknown>).accountId === undefined
        ? [c[0], { accountId, ...(c[1] as Record<string, unknown>) }, c[2]]
        : c,
    );
    const body = {
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:mail',
        'urn:ietf:params:jmap:submission',
        'urn:ietf:params:jmap:vacationresponse',
      ],
      methodCalls: calls,
    };
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

  private draftCreateObject(draft: StalwartDraftRequest, draftsMailboxId: string): Record<string, unknown> {
    const toList = draft.toAddresses?.length ? draft.toAddresses : [draft.toAddress];
    const outbound: Record<string, unknown> = {
      mailboxIds: { [draftsMailboxId]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ email: draft.fromAddress, name: draft.fromName ?? null }],
      to: toList.map((email) => ({ email })),
      subject: draft.subject,
      bodyValues: draft.bodyHtml
        ? { body: { value: draft.body }, html: { value: draft.bodyHtml } }
        : { body: { value: draft.body } },
      textBody: [{ partId: 'body', type: 'text/plain' }],
    };
    if (draft.bodyHtml) {
      outbound['htmlBody'] = [{ partId: 'html', type: 'text/html' }];
    }
    if (draft.cc?.length) outbound.cc = draft.cc.map((email) => ({ email }));
    if (draft.bcc?.length) outbound.bcc = draft.bcc.map((email) => ({ email }));
    if (draft.attachments?.length) {
      outbound.attachments = draft.attachments.map((a) => ({
        blobId: a.blobId,
        type: a.type,
        name: a.name,
      }));
    }
    // Thread the draft: JMAP Email.inReplyTo / references are arrays of bare RFC
    // Message-IDs (angle brackets stripped) — mirrors the send lane so James groups a
    // saved reply-draft under its conversation.
    if (draft.inReplyTo) outbound.inReplyTo = [draft.inReplyTo.replace(/^<|>$/g, '')];
    if (draft.references?.length) {
      outbound.references = draft.references.map((r) => r.replace(/^<|>$/g, ''));
    }
    return outbound;
  }

  private async saveDraftRequest(
    mailbox: string,
    draft: StalwartDraftRequest,
    draftId?: string,
  ): Promise<{ id: string } | null> {
    if (!this.jmapUrl) return null;
    const draftsMailboxId = await this.resolveMailboxIdForRole(mailbox, 'drafts');
    if (!draftsMailboxId) return null;
    const create = this.draftCreateObject(draft, draftsMailboxId);
    const responses = await this.jmap(
      draftId
        ? [
            ['Email/set', { create: { draft: create }, destroy: [draftId] }, '0'],
          ]
        : [
            [
              'Email/set',
              {
                create: {
                  draft: create,
                },
              },
              '0',
            ],
          ],
      mailbox,
    );
    if (!responses) return null;
    const created = this.named(responses, 'Email/set')?.created?.draft;
    const id = typeof created?.id === 'string' ? created.id : null;
    return id ? { id } : null;
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

  /** Resolve the JMAP mailbox id for a folder's role, under `forAddress`'s account. Null when absent. */
  private async resolveMailboxIdForRole(forAddress: string, role: string): Promise<string | null> {
    const responses = await this.jmap([['Mailbox/query', { filter: { role } }, '0']], forAddress);
    if (!responses) return null;
    const ids = this.named(responses, 'Mailbox/query')?.ids;
    return Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : null;
  }

  // --- StalwartPort implementation ----------------------------------------

  async listThreads(mailbox: string, address: string): Promise<StalwartThread[]> {
    if (!this.jmapUrl) return [];
    // Standard JMAP against the MAILBOX's own (delegated) account: query
    // collapsed-by-thread (one representative email per thread) filtered by the
    // CONTACT's address — the port contract is "threads that involve `address`",
    // so the from/to filter is real filtering, not an account workaround — then
    // fetch those emails, and fetch the threads for accurate message counts.
    // Tolerant of missing pieces (degrade to []).
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
    ], mailbox);
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
        flagged: keywords['$flagged'] === true,
        lastMessageAt: typeof (m as any).receivedAt === 'string' ? (m as any).receivedAt : null,
        lastSnippet: typeof (m as any).preview === 'string' ? (m as any).preview : null,
        participants,
      });
    }
    return out;
  }

  async listMessages(mailbox: string, threadId: string): Promise<StalwartMessage[]> {
    if (!this.jmapUrl) return [];
    // Standard JMAP Thread/get → Email/get chain (portable across JMAP engines),
    // scoped to the mailbox's own (delegated) account — thread ids live per-account.
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
    ], mailbox);
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

  /**
   * Live, folder-scoped, paged, (optionally) full-text-searched thread listing —
   * the webmail wave's search+paging surface. Resolves the folder's JMAP
   * mailbox id (by role) under the mailbox's own account, then
   * Email/query(inMailbox[+text]) → Email/get(incl. hasAttachment) →
   * Thread/get(counts). Degrade-clean at every step (missing folder / failed
   * call → `{ threads: [] }`).
   */
  async listFolderThreads(mailbox: string, query: StalwartFolderQuery): Promise<StalwartFolderThreadsResult> {
    if (!this.jmapUrl) return { threads: [] };
    // A custom-folder id (query.mailboxId) overrides the role — the query is
    // scoped straight to that mailbox. A foreign id yields an empty (account-
    // scoped) result rather than leaking, so no extra validation is needed here.
    const mailboxId = query.mailboxId
      ? query.mailboxId
      : await this.resolveMailboxIdForRole(mailbox, FOLDER_ROLE[query.folder] ?? 'inbox');
    if (!mailboxId) return { threads: [] };

    // Search v2: parse Gmail-style operators (from:/to:/subject:/has:attachment/
    // before:/after:) out of the query and build the JMAP filter, AND-ed with the
    // folder mailbox. Plain text and an empty query both fall through correctly
    // (buildJmapFilter → { inMailbox } when nothing else parses).
    const filter = buildJmapFilter(parseSearchQuery(query.query), mailboxId);

    const responses = await this.jmap([
      [
        'Email/query',
        {
          filter,
          collapseThreads: true,
          sort: [{ property: 'receivedAt', isAscending: false }],
          position: query.offset,
          limit: query.limit,
          calculateTotal: true,
        },
        '0',
      ],
      [
        'Email/get',
        {
          '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
          properties: [
            'id', 'threadId', 'subject', 'from', 'to', 'receivedAt', 'preview', 'keywords', 'hasAttachment',
          ],
        },
        '1',
      ],
      ['Thread/get', { '#ids': { resultOf: '1', name: 'Email/get', path: '/list/*/threadId' } }, '2'],
    ], mailbox);
    if (!responses) return { threads: [] };
    const emails = this.named(responses, 'Email/get')?.list;
    if (!Array.isArray(emails)) return { threads: [] };
    const threadList = this.named(responses, 'Thread/get')?.list;
    const countByThread = new Map<string, number>();
    if (Array.isArray(threadList)) {
      for (const t of threadList) {
        const id = (t as any)?.id;
        const ids = (t as any)?.emailIds;
        if (typeof id === 'string' && Array.isArray(ids)) countByThread.set(id, ids.length);
      }
    }
    const threads: StalwartThread[] = [];
    for (const m of emails) {
      if (!m || typeof m !== 'object') continue;
      const threadId = (m as any).threadId;
      if (typeof threadId !== 'string' || !threadId) continue;
      const keywords = (m as any).keywords ?? {};
      threads.push({
        id: threadId,
        subject: typeof (m as any).subject === 'string' ? (m as any).subject : null,
        messageCount: countByThread.get(threadId) ?? 1,
        unread: keywords['$seen'] !== true,
        lastMessageAt: typeof (m as any).receivedAt === 'string' ? (m as any).receivedAt : null,
        lastSnippet: typeof (m as any).preview === 'string' ? (m as any).preview : null,
        participants: [...this.toParticipants((m as any).from), ...this.toParticipants((m as any).to)],
        hasAttachments: (m as any).hasAttachment === true,
      });
    }
    const total = this.named(responses, 'Email/query')?.total;
    return { threads, total: typeof total === 'number' ? total : undefined };
  }

  /**
   * The FULL detail of every message in a thread — bodies (raw HTML/text),
   * cc, threading headers, read state, attachments. Two round trips
   * (Thread/get for the ordered emailIds, then Email/get for the detail) since
   * Email/set-style patches can't target a back-reference-only id list, and we
   * want a clean [] on any missing piece rather than a half-built object.
   */
  async getThreadDetail(mailbox: string, threadId: string): Promise<StalwartMessageDetail[]> {
    if (!this.jmapUrl) return [];
    const responses = await this.jmap([
      ['Thread/get', { ids: [threadId] }, '0'],
      [
        'Email/get',
        {
          '#ids': { resultOf: '0', name: 'Thread/get', path: '/list/*/emailIds' },
          properties: [
            'id', 'threadId', 'from', 'to', 'cc', 'bcc', 'subject', 'receivedAt', 'preview', 'keywords',
            'messageId', 'references', 'htmlBody', 'textBody', 'bodyValues', 'attachments',
          ],
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
        },
        '1',
      ],
    ], mailbox);
    if (!responses) return [];
    const list = this.named(responses, 'Email/get')?.list;
    if (!Array.isArray(list)) return [];
    const out: StalwartMessageDetail[] = [];
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
      const bodyValues = (m as any).bodyValues && typeof (m as any).bodyValues === 'object'
        ? ((m as any).bodyValues as Record<string, { value?: unknown }>)
        : {};
      const htmlBody = this.bodyText((m as any).htmlBody, bodyValues);
      const textBody = this.bodyText((m as any).textBody, bodyValues);
      const messageIdArr = (m as any).messageId;
      const messageIdHeader =
        Array.isArray(messageIdArr) && typeof messageIdArr[0] === 'string' ? messageIdArr[0] : null;
      const referencesArr = (m as any).references;
      const references = Array.isArray(referencesArr)
        ? referencesArr.filter((r): r is string => typeof r === 'string')
        : null;
      const attachments: StalwartAttachment[] = Array.isArray((m as any).attachments)
        ? (m as any).attachments
            .filter((a: unknown) => a && typeof a === 'object' && typeof (a as any).blobId === 'string')
            .map((a: any) => ({
              blobId: a.blobId,
              name: typeof a.name === 'string' ? a.name : null,
              type: typeof a.type === 'string' ? a.type : null,
              size: typeof a.size === 'number' ? a.size : null,
              cid: typeof a.cid === 'string' ? a.cid : null,
            }))
        : [];
      out.push({
        id,
        threadId: typeof (m as any).threadId === 'string' ? (m as any).threadId : threadId,
        from: this.toParticipant(Array.isArray((m as any).from) ? (m as any).from[0] : null),
        to: this.toParticipants((m as any).to),
        cc: this.toParticipants((m as any).cc),
        bcc: this.toParticipants((m as any).bcc),
        subject: typeof (m as any).subject === 'string' ? (m as any).subject : null,
        sentAt: typeof (m as any).receivedAt === 'string' ? (m as any).receivedAt : null,
        preview: typeof (m as any).preview === 'string' ? (m as any).preview : null,
        direction,
        htmlBody,
        textBody,
        messageIdHeader,
        references,
        isUnread: keywords['$seen'] !== true,
        flagged: keywords['$flagged'] === true,
        attachments,
      });
    }
    return out;
  }

  /** Resolve a JMAP `htmlBody`/`textBody` EmailBodyPart list to its bodyValues text. */
  private bodyText(parts: unknown, bodyValues: Record<string, { value?: unknown }>): string | null {
    if (!Array.isArray(parts) || !parts.length) return null;
    const partId = (parts[0] as any)?.partId;
    if (typeof partId !== 'string') return null;
    const value = bodyValues[partId]?.value;
    return typeof value === 'string' ? value : null;
  }

  /**
   * Set (read=true) or clear (read=false) the `$seen` keyword on every message
   * in a thread. Two round trips (resolve emailIds, then patch each) since the
   * update map's keys must be concrete ids. Returns false on any degrade step.
   */
  async setThreadRead(mailbox: string, threadId: string, read: boolean): Promise<boolean> {
    if (!this.jmapUrl) return false;
    const idsResp = await this.jmap([['Thread/get', { ids: [threadId] }, '0']], mailbox);
    if (!idsResp) return false;
    const emailIds = this.named(idsResp, 'Thread/get')?.list?.[0]?.emailIds;
    if (!Array.isArray(emailIds) || emailIds.length === 0) return false;
    const update: Record<string, Record<string, boolean>> = {};
    for (const id of emailIds) {
      if (typeof id === 'string') update[id] = { 'keywords/$seen': read };
    }
    if (Object.keys(update).length === 0) return false;
    const setResp = await this.jmap([['Email/set', { update }, '0']], mailbox);
    if (!setResp) return false;
    const result = this.named(setResp, 'Email/set');
    // Honest success = at least one email actually flipped (mirrors moveThreadToFolder).
    const updatedCount = result?.updated ? Object.keys(result.updated).length : 0;
    return updatedCount > 0;
  }

  async setThreadFlags(
    mailbox: string,
    threadId: string,
    flags: { seen?: boolean; flagged?: boolean },
  ): Promise<boolean> {
    if (!this.jmapUrl) return false;
    const idsResp = await this.jmap([['Thread/get', { ids: [threadId] }, '0']], mailbox);
    if (!idsResp) return false;
    const emailIds = this.named(idsResp, 'Thread/get')?.list?.[0]?.emailIds;
    if (!Array.isArray(emailIds) || emailIds.length === 0) return false;
    const patch: Record<string, boolean> = {};
    if (flags.seen !== undefined) patch['keywords/$seen'] = flags.seen;
    if (flags.flagged !== undefined) patch['keywords/$flagged'] = flags.flagged;
    if (Object.keys(patch).length === 0) return false;
    const update: Record<string, Record<string, boolean>> = {};
    for (const id of emailIds) {
      if (typeof id === 'string') update[id] = patch;
    }
    if (Object.keys(update).length === 0) return false;
    const setResp = await this.jmap([['Email/set', { update }, '0']], mailbox);
    if (!setResp) return false;
    const result = this.named(setResp, 'Email/set');
    const updatedCount = result?.updated ? Object.keys(result.updated).length : 0;
    return updatedCount > 0;
  }

  /**
   * Move every message in a thread into the folder for `folder` under the
   * mailbox's own account. Resolve the target folder's JMAP mailbox id (by
   * role), then `Email/set` each message's `mailboxIds` to exactly that folder
   * — a real move (out of Inbox, into Archive/Trash/Junk), not just an overlay
   * tag. Two round trips (resolve emailIds, then patch). Returns false on any
   * degrade step (not configured / thread unknown here / no such folder / set
   * failed) so the caller can try the next mailbox.
   */
  async moveThreadToFolder(
    mailbox: string,
    threadId: string,
    folder: StalwartFolderQuery['folder'],
  ): Promise<boolean> {
    if (!this.jmapUrl) return false;
    const role = FOLDER_ROLE[folder];
    const targetMailboxId = await this.resolveMailboxIdForRole(mailbox, role);
    if (!targetMailboxId) return false;
    const idsResp = await this.jmap([['Thread/get', { ids: [threadId] }, '0']], mailbox);
    if (!idsResp) return false;
    const emailIds = this.named(idsResp, 'Thread/get')?.list?.[0]?.emailIds;
    if (!Array.isArray(emailIds) || emailIds.length === 0) return false;
    // Setting the whole `mailboxIds` map (not a `mailboxIds/<id>` patch) moves the
    // message OUT of its current folder into exactly the target — the move we want.
    const update: Record<string, Record<string, unknown>> = {};
    for (const id of emailIds) {
      if (typeof id === 'string') update[id] = { mailboxIds: { [targetMailboxId]: true } };
    }
    if (Object.keys(update).length === 0) return false;
    const setResp = await this.jmap([['Email/set', { update }, '0']], mailbox);
    if (!setResp) return false;
    const result = this.named(setResp, 'Email/set');
    const updatedCount = result?.updated ? Object.keys(result.updated).length : 0;
    return updatedCount > 0;
  }

  /** Move a thread into a CUSTOM folder by JMAP mailbox id (validates the target exists). */
  async moveThreadToMailbox(mailbox: string, threadId: string, targetMailboxId: string): Promise<boolean> {
    if (!this.jmapUrl) return false;
    // The target must be a real mailbox in THIS account — never move into an
    // unknown or foreign id (which JMAP would otherwise silently accept/refuse).
    const probe = await this.jmap([
      ['Mailbox/get', { ids: [targetMailboxId], properties: ['id'] }, '0'],
    ], mailbox);
    if (!probe) return false;
    const exists = this.named(probe, 'Mailbox/get')?.list?.[0]?.id === targetMailboxId;
    if (!exists) return false;
    const idsResp = await this.jmap([['Thread/get', { ids: [threadId] }, '0']], mailbox);
    if (!idsResp) return false;
    const emailIds = this.named(idsResp, 'Thread/get')?.list?.[0]?.emailIds;
    if (!Array.isArray(emailIds) || emailIds.length === 0) return false;
    // Set the whole mailboxIds map (not a patch) → the message leaves its current
    // folder for exactly the target, mirroring moveThreadToFolder's mechanics.
    const update: Record<string, Record<string, unknown>> = {};
    for (const id of emailIds) {
      if (typeof id === 'string') update[id] = { mailboxIds: { [targetMailboxId]: true } };
    }
    if (Object.keys(update).length === 0) return false;
    const setResp = await this.jmap([['Email/set', { update }, '0']], mailbox);
    if (!setResp) return false;
    const result = this.named(setResp, 'Email/set');
    const updatedCount = result?.updated ? Object.keys(result.updated).length : 0;
    return updatedCount > 0;
  }

  async emptyFolder(mailbox: string, folder: 'trash' | 'spam'): Promise<number | null> {
    if (!this.jmapUrl) return null;
    const role = FOLDER_ROLE[folder];
    const mailboxId = await this.resolveMailboxIdForRole(mailbox, role);
    if (!mailboxId) return null;
    // Purge in batches until the folder is empty (JMAP Email/query is capped per
    // call, so a single pass would silently leave a large Trash/Spam partly full).
    let purged = 0;
    let sawAny = false;
    for (let batch = 0; batch < 100; batch += 1) {
      const queryResp = await this.jmap([
        ['Email/query', { filter: { inMailbox: mailboxId }, limit: 1000 }, '0'],
      ], mailbox);
      if (!queryResp) return sawAny ? purged : null;
      const ids = this.named(queryResp, 'Email/query')?.ids;
      if (!Array.isArray(ids)) return sawAny ? purged : null;
      const destroy = ids.filter((id): id is string => typeof id === 'string' && !!id);
      if (destroy.length === 0) break;
      sawAny = true;
      const setResp = await this.jmap([['Email/set', { destroy }, '0']], mailbox);
      if (!setResp) return purged;
      const result = this.named(setResp, 'Email/set');
      const n = result?.destroyed ? Object.keys(result.destroyed).length : 0;
      purged += n;
      // Nothing actually deleted this round -> stop to avoid an infinite loop.
      if (n === 0) break;
    }
    return purged;
  }

  async saveDraft(mailbox: string, draft: StalwartDraftRequest): Promise<{ id: string } | null> {
    return this.saveDraftRequest(mailbox, draft);
  }

  async updateDraft(
    mailbox: string,
    draftId: string,
    draft: StalwartDraftRequest,
  ): Promise<{ id: string } | null> {
    return this.saveDraftRequest(mailbox, draft, draftId);
  }

  async deleteDraft(mailbox: string, draftId: string): Promise<boolean> {
    if (!this.jmapUrl) return false;
    const setResp = await this.jmap([['Email/set', { destroy: [draftId] }, '0']], mailbox);
    if (!setResp) return false;
    const result = this.named(setResp, 'Email/set');
    return !!result?.destroyed && Object.keys(result.destroyed).length > 0;
  }

  async getVacation(mailbox: string): Promise<StalwartVacationState | null> {
    if (!this.jmapUrl) return null;
    const responses = await this.jmap(
      [['VacationResponse/get', { ids: ['singleton'] }, '0']],
      mailbox,
    );
    if (!responses) return null;
    const row = this.named(responses, 'VacationResponse/get')?.list?.[0];
    if (!row || typeof row !== 'object') return null;
    const isEnabled = (row as any).isEnabled === true;
    return {
      isEnabled,
      subject: typeof (row as any).subject === 'string' ? (row as any).subject : null,
      textBody: typeof (row as any).textBody === 'string' ? (row as any).textBody : null,
      htmlBody: typeof (row as any).htmlBody === 'string' ? (row as any).htmlBody : null,
      fromDate: typeof (row as any).fromDate === 'string' ? (row as any).fromDate : null,
      toDate: typeof (row as any).toDate === 'string' ? (row as any).toDate : null,
    };
  }

  async setVacation(mailbox: string, state: StalwartVacationState): Promise<boolean> {
    if (!this.jmapUrl) return false;
    const responses = await this.jmap(
      [
        [
          'VacationResponse/set',
          {
            update: {
              singleton: {
                isEnabled: state.isEnabled,
                subject: state.subject,
                textBody: state.textBody,
                htmlBody: state.htmlBody,
                fromDate: state.fromDate,
                toDate: state.toDate,
              },
            },
          },
          '0',
        ],
      ],
      mailbox,
    );
    if (!responses) return false;
    const updated = this.named(responses, 'VacationResponse/set')?.updated?.singleton;
    return !!updated;
  }

  /** The Inbox unread/total counts for one mailbox (JMAP Mailbox `role: inbox`). */
  async getMailboxCounts(mailbox: string): Promise<StalwartMailboxCounts | null> {
    if (!this.jmapUrl) return null;
    const responses = await this.jmap([
      ['Mailbox/query', { filter: { role: 'inbox' } }, '0'],
      [
        'Mailbox/get',
        {
          '#ids': { resultOf: '0', name: 'Mailbox/query', path: '/ids' },
          properties: ['id', 'role', 'unreadEmails', 'totalEmails'],
        },
        '1',
      ],
    ], mailbox);
    if (!responses) return null;
    const list = this.named(responses, 'Mailbox/get')?.list;
    const inbox = Array.isArray(list) ? list[0] : undefined;
    if (!inbox) return null;
    return {
      inboxUnread: typeof inbox.unreadEmails === 'number' ? inbox.unreadEmails : 0,
      inboxTotal: typeof inbox.totalEmails === 'number' ? inbox.totalEmails : 0,
    };
  }

  /**
   * Resolve one message's real Message-ID + References headers by its JMAP
   * email id (used to build a correct In-Reply-To/References chain when the
   * caller only has an internal message id, e.g. from the thread-detail API).
   */
  async getMessageHeaders(mailbox: string, messageId: string): Promise<StalwartMessageHeaders | null> {
    if (!this.jmapUrl) return null;
    const responses = await this.jmap([
      ["Email/get", { ids: [messageId], properties: ["messageId", "references"] }, "0"],
    ], mailbox);
    if (!responses) return null;
    const list = this.named(responses, "Email/get")?.list;
    const m = Array.isArray(list) ? list[0] : undefined;
    if (!m) return null;
    const messageIdArr = (m as any).messageId;
    const messageIdHeader =
      Array.isArray(messageIdArr) && typeof messageIdArr[0] === "string" ? messageIdArr[0] : null;
    const referencesArr = (m as any).references;
    const references = Array.isArray(referencesArr)
      ? referencesArr.filter((r: unknown): r is string => typeof r === "string")
      : null;
    return { messageIdHeader, references };
  }

  /** Download one blob (an attachment's bytes) via the JMAP session `downloadUrl` template. */
  async downloadBlob(mailbox: string, blobId: string): Promise<StalwartBlobDownload | null> {
    if (!this.jmapUrl) return null;
    await this.ensureBlobTemplates();
    const accountId = await this.resolveAccountIdFor(mailbox);
    if (!accountId || !this.downloadUrlTemplate) return null;
    const url = this.downloadUrlTemplate
      .replace('{accountId}', encodeURIComponent(accountId))
      .replace('{blobId}', encodeURIComponent(blobId))
      .replace('{type}', encodeURIComponent('application/octet-stream'))
      .replace('{name}', encodeURIComponent('attachment'));
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, { method: 'GET', headers: this.authHeaders() });
    } catch (err) {
      this.logger.warn(`James blob download transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`James blob download HTTP ${res.status}`);
      return null;
    }
    try {
      const data = Buffer.from(await res.arrayBuffer());
      return { data, contentType: res.headers.get('content-type') };
    } catch (err) {
      this.logger.warn(`James blob download read error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Upload a blob (an attachment) via the JMAP session `uploadUrl` template. */
  async uploadBlob(mailbox: string, file: Buffer, type: string, _filename: string): Promise<StalwartUploadResult | null> {
    if (!this.jmapUrl) return null;
    await this.ensureBlobTemplates();
    const accountId = await this.resolveAccountIdFor(mailbox);
    if (!accountId || !this.uploadUrlTemplate) return null;
    const url = this.uploadUrlTemplate.replace('{accountId}', encodeURIComponent(accountId));
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': type || 'application/octet-stream' },
        body: file as unknown as BodyInit,
      });
    } catch (err) {
      this.logger.warn(`James blob upload transport error: ${(err as Error).message}`);
      return null;
    }
    if (!res.ok) {
      this.logger.warn(`James blob upload HTTP ${res.status}`);
      return null;
    }
    try {
      const body = (await res.json()) as { blobId?: unknown; type?: unknown; size?: unknown };
      if (typeof body?.blobId !== 'string') return null;
      return {
        blobId: body.blobId,
        type: typeof body.type === 'string' ? body.type : type || 'application/octet-stream',
        size: typeof body.size === 'number' ? body.size : file.length,
      };
    } catch (err) {
      this.logger.warn(`James blob upload non-JSON response: ${(err as Error).message}`);
      return null;
    }
  }

  async send(
    mailbox: string,
    request: StalwartSendRequest,
    transactional: boolean,
  ): Promise<StalwartSendResult> {
    const hasAttachments = (request.attachments?.length ?? 0) > 0;
    // Postmark is the only SPF-authorised egress for these domains, so route
    // through it whenever it is configured (transactional and otherwise) — EXCEPT
    // an attachment-bearing send, which routes via JMAP (see the file banner).
    if (this.postmarkConfigured && !hasAttachments) {
      return this.sendViaPostmark(request);
    }
    if (this.jmapUrl) {
      return this.sendViaJames(request);
    }
    if (this.postmarkConfigured) {
      // Reached only with attachments present AND JAMES_JMAP_URL unset (a misconfig):
      // the Postmark lane cannot carry the blob reference. FAIL LOUD rather than
      // silently sending without the attachment — an accepted:true that dropped the
      // file is worse than a clear failure the caller can surface and retry.
      this.logger.error(
        'send: attachments requested but JAMES_JMAP_URL unset — refusing to send WITHOUT them',
      );
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: null,
        reason: 'attachments require the JMAP lane, but JAMES_JMAP_URL is not configured',
      };
    }
    return {
      accepted: false,
      providerMessageId: null,
      threadId: request.inReplyToThreadId ?? null,
      lane: null,
      reason: 'mail engine not configured (JAMES_JMAP_URL + POSTMARK_SERVER_TOKEN unset)',
    };
  }

  /** Ensure a Message-ID-shaped value is wrapped in angle brackets for a mail header. */
  private angleWrap(id: string): string {
    const trimmed = id.trim();
    return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
  }

  private async sendViaPostmark(request: StalwartSendRequest): Promise<StalwartSendResult> {
    const token = this.postmarkToken!;
    const fromHeader = request.fromName
      ? `${request.fromName} <${request.fromAddress}>`
      : request.fromAddress;
    const headers: { Name: string; Value: string }[] = [];
    if (request.inReplyTo) headers.push({ Name: 'In-Reply-To', Value: this.angleWrap(request.inReplyTo) });
    if (request.references?.length) {
      headers.push({ Name: 'References', Value: request.references.map((r) => this.angleWrap(r)).join(' ') });
    }
    // Wave 7: custom outbound headers (e.g. the X-UC-Agent-Autoreply loop marker).
    for (const h of request.headers ?? []) {
      headers.push({ Name: h.name, Value: h.value });
    }
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
          ...(request.cc?.length ? { Cc: request.cc.join(', ') } : {}),
          ...(request.bcc?.length ? { Bcc: request.bcc.join(', ') } : {}),
          Subject: request.subject,
          TextBody: request.body,
          ...(request.bodyHtml ? { HtmlBody: request.bodyHtml } : {}),
          MessageStream: 'outbound',
          ...(headers.length ? { Headers: headers } : {}),
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
    // Best-effort JMAP submission under the FROM mailbox's own (delegated)
    // account: resolve a sending Identity for the from address, stage the
    // Email (cc/bcc/attachments/threading via JMAP's convenience properties —
    // the server builds the MIME structure from these), and submit.
    // Degrade-clean on any gap.
    const idResp = await this.jmap([['Identity/get', {}, '0']], request.fromAddress);
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
    const toList = request.toAddresses?.length ? request.toAddresses : [request.toAddress];

    // RFC 8621 §4.6: every Email MUST belong to ≥1 mailbox on create — James
    // REJECTS a create with no mailboxIds. Stage the outbound message in Drafts
    // ($draft), submit it, then move it to Sent on success via
    // onSuccessUpdateEmail (below). This un-breaks every JMAP send (the only lane
    // for attachments) AND populates the Sent folder that IMAP/JMAP clients read.
    const sentMailboxId = await this.resolveMailboxIdForRole(request.fromAddress, 'sent');
    const draftsMailboxId = await this.resolveMailboxIdForRole(request.fromAddress, 'drafts');
    const stageMailboxId =
      draftsMailboxId ?? sentMailboxId ?? (await this.resolveMailboxIdForRole(request.fromAddress, 'inbox'));
    if (!stageMailboxId) {
      return {
        accepted: false,
        providerMessageId: null,
        threadId: request.inReplyToThreadId ?? null,
        lane: 'james',
        reason: 'no James mailbox to stage the outbound message',
      };
    }
    const stagedInDrafts = stageMailboxId === draftsMailboxId;
    const outbound: Record<string, unknown> = {
      mailboxIds: { [stageMailboxId]: true },
      keywords: stagedInDrafts ? { $draft: true, $seen: true } : { $seen: true },
      from: [{ email: request.fromAddress, name: request.fromName ?? null }],
      to: toList.map((email) => ({ email })),
      subject: request.subject,
      bodyValues: { body: { value: request.body } },
      textBody: [{ partId: 'body', type: 'text/plain' }],
    };
    if (request.bodyHtml) {
      outbound.bodyValues = {
        body: { value: request.body },
        html: { value: request.bodyHtml },
      };
      outbound.htmlBody = [{ partId: 'html', type: 'text/html' }];
    }
    if (request.cc?.length) outbound.cc = request.cc.map((email) => ({ email }));
    if (request.bcc?.length) outbound.bcc = request.bcc.map((email) => ({ email }));
    if (request.inReplyTo) outbound.inReplyTo = [request.inReplyTo.replace(/^<|>$/g, '')];
    if (request.references?.length) {
      outbound.references = request.references.map((r) => r.replace(/^<|>$/g, ''));
    }
    // Wave 7: custom outbound headers via the RFC 8621 header:{name} property
    // form (e.g. the X-UC-Agent-Autoreply loop-protection marker).
    for (const h of request.headers ?? []) {
      outbound[`header:${h.name}:asText`] = h.value;
    }
    if (request.attachments?.length) {
      outbound.attachments = request.attachments.map((a) => ({
        blobId: a.blobId,
        type: a.type,
        name: a.name,
      }));
    }
    // On successful submission, move the message out of Drafts into Sent and drop
    // the $draft keyword (onSuccessUpdateEmail patches the Email the submission
    // sent). Only when we staged in Drafts AND a distinct Sent mailbox exists.
    const submissionArgs: Record<string, unknown> = {
      create: { sub: { emailId: '#outbound', identityId: identity.id } },
    };
    if (stagedInDrafts && sentMailboxId && sentMailboxId !== stageMailboxId) {
      submissionArgs.onSuccessUpdateEmail = {
        '#sub': {
          'keywords/$draft': null,
          [`mailboxIds/${stageMailboxId}`]: null,
          [`mailboxIds/${sentMailboxId}`]: true,
        },
      };
    }
    const responses = await this.jmap([
      ['Email/set', { create: { outbound } }, '0'],
      ['EmailSubmission/set', submissionArgs, '1'],
    ], request.fromAddress);
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

  /** Every folder under the mailbox's account (JMAP `Mailbox/get` all ids). */
  async listFolders(mailbox: string): Promise<StalwartMailFolder[]> {
    if (!this.jmapUrl) return [];
    const responses = await this.jmap([
      ['Mailbox/get', { ids: null, properties: ['id', 'name', 'role', 'parentId', 'unreadEmails'] }, '0'],
    ], mailbox);
    if (!responses) return [];
    const list = this.named(responses, 'Mailbox/get')?.list;
    if (!Array.isArray(list)) return [];
    return list
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as any).id === 'string')
      .map((m) => ({
        id: m.id as string,
        name: typeof m.name === 'string' ? m.name : '',
        role: typeof m.role === 'string' ? m.role : null,
        parentId: typeof m.parentId === 'string' ? m.parentId : null,
        unread: typeof m.unreadEmails === 'number' ? m.unreadEmails : undefined,
      }));
  }

  /** Create a user folder (`role: null` Mailbox). Returns the new id, or null. */
  async createFolder(mailbox: string, name: string, parentId?: string | null): Promise<{ id: string } | null> {
    if (!this.jmapUrl) return null;
    const create: Record<string, unknown> = { name, role: null };
    if (parentId) create.parentId = parentId;
    const responses = await this.jmap([
      ['Mailbox/set', { create: { newFolder: create } }, '0'],
    ], mailbox);
    if (!responses) return null;
    const created = this.named(responses, 'Mailbox/set')?.created?.newFolder;
    const id = typeof created?.id === 'string' ? created.id : null;
    return id ? { id } : null;
  }

  /** Rename a folder. True iff the engine reports the id updated. */
  async renameFolder(mailbox: string, folderId: string, name: string): Promise<boolean> {
    if (!this.jmapUrl) return false;
    const responses = await this.jmap([
      ['Mailbox/set', { update: { [folderId]: { name } } }, '0'],
    ], mailbox);
    if (!responses) return false;
    const updated = this.named(responses, 'Mailbox/set')?.updated;
    return !!updated && Object.prototype.hasOwnProperty.call(updated, folderId);
  }

  /**
   * Destroy a USER folder. First reads the target's role; REFUSES a role
   * (system) folder — Inbox/Sent/Archive/Trash/Junk/Drafts are never deletable.
   */
  async deleteFolder(mailbox: string, folderId: string): Promise<boolean> {
    if (!this.jmapUrl) return false;
    const probe = await this.jmap([
      ['Mailbox/get', { ids: [folderId], properties: ['id', 'role'] }, '0'],
    ], mailbox);
    if (!probe) return false;
    const list = this.named(probe, 'Mailbox/get')?.list;
    const target = Array.isArray(list) ? list[0] : undefined;
    if (!target || typeof target.id !== 'string') return false;
    // Never delete a system/role folder.
    if (target.role != null) return false;
    const responses = await this.jmap([
      ['Mailbox/set', { destroy: [folderId] }, '0'],
    ], mailbox);
    if (!responses) return false;
    const destroyed = this.named(responses, 'Mailbox/set')?.destroyed;
    return Array.isArray(destroyed) && destroyed.includes(folderId);
  }

  async pollInbound(mailbox: string, sinceIso: string | null): Promise<InboundPollResult | null> {
    if (!this.jmapUrl) return null;
    const inboxId = await this.resolveMailboxIdForRole(mailbox, 'inbox');
    if (!inboxId) return null;
    // Newest inbox messages first; one Email/get for the fields the classifier needs.
    const responses = await this.jmap(
      [
        [
          'Email/query',
          {
            filter: { inMailbox: inboxId },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit: 50,
          },
          '0',
        ],
        [
          'Email/get',
          {
            '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
            // The header:… property (RFC 8621 §4.1.3) reads the Wave-7 agent
            // auto-reply loop marker so the runtime can suppress reply loops.
            properties: [
              'id',
              'threadId',
              'subject',
              'from',
              'to',
              'receivedAt',
              'header:X-UC-Agent-Autoreply:asText',
            ],
          },
          '1',
        ],
      ],
      mailbox,
    );
    if (!responses) return null;
    const list = this.named(responses, 'Email/get')?.list;
    if (!Array.isArray(list)) return null;

    const refs = list
      .map((m: any) => ({
        threadId: typeof m?.threadId === 'string' ? m.threadId : '',
        fromAddress:
          Array.isArray(m?.from) && m.from[0]?.email ? String(m.from[0].email) : null,
        // The REAL To recipients — rules' 'to' conditions match against these.
        toAddresses: Array.isArray(m?.to)
          ? m.to.map((a: any) => (a?.email ? String(a.email) : '')).filter(Boolean)
          : [],
        subject: typeof m?.subject === 'string' ? m.subject : null,
        receivedAt: typeof m?.receivedAt === 'string' ? m.receivedAt : '',
        // Present + non-empty header value ⇒ an agent runtime auto-sent this.
        agentAutoreply:
          typeof m?.['header:X-UC-Agent-Autoreply:asText'] === 'string' &&
          m['header:X-UC-Agent-Autoreply:asText'].trim() !== '',
      }))
      .filter((r) => r.threadId && r.receivedAt);

    // JMAP receivedAt is UTC ISO-8601 ('…Z') → lexical compare == chronological.
    const maxCursor = refs.reduce((mx, r) => (r.receivedAt > mx ? r.receivedAt : mx), sinceIso ?? '');

    // First poll baselines: capture the cursor, process no backlog. An EMPTY inbox
    // has no message receivedAt to anchor on — stamp NOW so the cursor is non-null
    // and the very next arrival is treated as new (else an empty mailbox would
    // re-baseline forever and never classify its first message).
    if (sinceIso == null) {
      return { cursor: maxCursor || new Date().toISOString(), newMessages: [] };
    }
    const newMessages = refs
      .filter((r) => r.receivedAt > sinceIso)
      .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0));
    return { cursor: maxCursor || sinceIso, newMessages };
  }
}
