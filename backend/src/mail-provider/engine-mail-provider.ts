/**
 * EngineMailProvider — the external-provider impl of MailProviderPort.
 *
 * Handles 'gmail' and 'microsoft' mailboxes by resolving a per-request OAuth
 * token from the Keycloak broker (keyed by the linking user's keycloakId, which
 * is MailboxAccount.ownerKey) and calling the cleaner-engine's /mail/* routes —
 * reusing the exact token→credentials→engine chain the Cleaner already uses.
 *
 * Degrade-clean everywhere: no owner / no User row / no broker token / dormant
 * engine → [] or accepted:false, never throws.
 */

import { Injectable, Logger } from '@nestjs/common';
import { MailboxAccount } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { ConnectedAccountsEnginePort } from '../connected-accounts/connected-accounts.port';
import { MessageView } from '../email/email.types';
import {
  MailProviderListOpts,
  MailProviderListResult,
  MailProviderDraftRequest,
  MailProviderDraftResult,
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from './mail-provider.port';
import { parseSearchQuery, buildGmailQuery } from '../stalwart/search-query';

type ExternalProvider = 'gmail' | 'microsoft';

@Injectable()
export class EngineMailProvider extends MailProviderPort {
  private readonly logger = new Logger(EngineMailProvider.name);

  constructor(
    private readonly engine: ConnectedAccountsEnginePort,
    private readonly broker: KeycloakBrokerService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  handles(mailbox: Pick<MailboxAccount, 'provider'>): boolean {
    return mailbox.provider === 'gmail' || mailbox.provider === 'microsoft';
  }

  async listInbox(
    mailbox: MailboxAccount,
    opts: MailProviderListOpts,
  ): Promise<MailProviderListResult> {
    const empty: MailProviderListResult = {
      threads: [],
      nextPageToken: null,
      hasMore: false,
      searchSupported: true,
      reason: null,
    };

    // Gmail/Graph paginate by opaque pageToken, NOT numeric offset. A page-2+
    // request that only carries offset would previously re-serve page 1 of the
    // unfiltered folder — the exact dishonest bug this method exists to fix.
    // Without a pageToken, any offset > 0 is an explicit "no more pages".
    const offset = opts.offset ?? 0;
    const pageToken = opts.pageToken?.trim() || null;
    if (offset > 0 && !pageToken) {
      return {
        ...empty,
        reason:
          'external mailboxes page by opaque page_token, not numeric offset — no more pages',
      };
    }

    const auth = await this.authFor(mailbox);
    if (!auth) return empty;

    // Map app search operators onto Gmail `q` syntax (Microsoft maps a subset
    // itself and returns search_supported:false for free-text it cannot honour).
    const rawQuery = opts.query?.trim() || '';
    const gmailQ = rawQuery ? buildGmailQuery(parseSearchQuery(rawQuery)) : '';

    const res = await this.engine.listMailThreads(
      auth.provider,
      auth.credentials,
      opts.folder,
      opts.limit,
      gmailQ || null,
      pageToken,
    );
    if (!res) return empty;

    const next = res.next_page_token ?? null;
    return {
      threads: (res.threads ?? []).map((t) => ({
        id: t.id,
        subject: t.subject,
        message_count: t.message_count,
        unread: t.unread,
        last_message_at: t.last_message_at,
        last_snippet: t.last_snippet,
        participants: t.participants.map((p) => ({ address: p.address, name: p.name })),
      })),
      nextPageToken: next,
      hasMore: Boolean(next ?? res.has_more),
      searchSupported: res.search_supported !== false,
      reason: res.reason ?? null,
    };
  }

  async listThreadMessages(mailbox: MailboxAccount, threadId: string): Promise<MessageView[]> {
    const auth = await this.authFor(mailbox);
    if (!auth) return [];
    const res = await this.engine.getMailThread(auth.provider, auth.credentials, threadId);
    if (!res) return [];
    return res.messages.map((m) => ({
      id: m.id,
      thread_id: m.thread_id,
      from: m.from ? { address: m.from.address, name: m.from.name } : null,
      to: m.to.map((p) => ({ address: p.address, name: p.name })),
      subject: m.subject,
      sent_at: m.sent_at,
      preview: m.preview,
      direction: m.direction,
      // Pass the full bodies the reader path now supplies through to the
      // MessageView; the frontend prefers html_body/text_body over preview.
      html_body: m.body_html ?? null,
      text_body: m.body_text ?? null,
    }));
  }

  async send(
    mailbox: MailboxAccount,
    req: MailProviderSendRequest,
  ): Promise<MailProviderSendResult> {
    const auth = await this.authFor(mailbox);
    if (!auth) {
      return { accepted: false, providerMessageId: null, threadId: null, reason: 'account_not_connected' };
    }
    const res = await this.engine.sendMail(auth.provider, auth.credentials, {
      from: req.from,
      to: req.to,
      subject: req.subject,
      body: req.body,
      bodyHtml: req.bodyHtml ?? null,
      cc: req.cc,
      bcc: req.bcc,
      inReplyToThreadId: req.inReplyToThreadId ?? null,
    });
    if (!res) {
      return { accepted: false, providerMessageId: null, threadId: null, reason: 'engine_unavailable' };
    }
    return {
      accepted: res.accepted,
      providerMessageId: res.provider_message_id,
      threadId: res.thread_id,
      reason: res.reason,
    };
  }

  /**
   * Mirror a staged draft into the provider's REAL Drafts folder (Graph
   * `POST /me/messages` for Microsoft). Sends NOTHING — the agent-inbox item
   * remains the approval choke point; this copy exists so the human can read
   * the exact text in their own Outlook before approving.
   */
  async createDraft(
    mailbox: MailboxAccount,
    req: MailProviderDraftRequest,
  ): Promise<MailProviderDraftResult> {
    const auth = await this.authFor(mailbox);
    if (!auth) {
      return {
        created: false,
        draftId: null,
        threadId: null,
        webLink: null,
        reason: 'account_not_connected',
      };
    }
    const res = await this.engine.createMailDraft(auth.provider, auth.credentials, {
      from: req.from,
      to: req.to,
      subject: req.subject,
      body: req.body,
      bodyHtml: req.bodyHtml ?? null,
      cc: req.cc,
      bcc: req.bcc,
      inReplyToThreadId: req.inReplyToThreadId ?? null,
    });
    if (!res) {
      return {
        created: false,
        draftId: null,
        threadId: null,
        webLink: null,
        reason: 'engine_unavailable',
      };
    }
    return {
      created: res.created,
      draftId: res.draft_id,
      threadId: res.thread_id,
      webLink: res.web_link,
      reason: res.reason,
    };
  }

  async deleteDraft(mailbox: MailboxAccount, draftId: string): Promise<boolean> {
    if (!draftId) return false;
    const auth = await this.authFor(mailbox);
    if (!auth) return false;
    const res = await this.engine.deleteMailDraft(auth.provider, auth.credentials, draftId);
    return res?.ok === true;
  }

  // Thread-level triage verbs: same auth chain as the reads, engine answers
  // {ok, moved} — ok:false (or a dormant engine's null) maps to false.

  async archiveThread(mailbox: MailboxAccount, threadId: string): Promise<boolean> {
    const auth = await this.authFor(mailbox);
    if (!auth) return false;
    const res = await this.engine.archiveMailThread(auth.provider, auth.credentials, threadId);
    return res?.ok === true;
  }

  async trashThread(mailbox: MailboxAccount, threadId: string): Promise<boolean> {
    const auth = await this.authFor(mailbox);
    if (!auth) return false;
    const res = await this.engine.trashMailThread(auth.provider, auth.credentials, threadId);
    return res?.ok === true;
  }

  async spamThread(mailbox: MailboxAccount, threadId: string): Promise<boolean> {
    const auth = await this.authFor(mailbox);
    if (!auth) return false;
    const res = await this.engine.spamMailThread(auth.provider, auth.credentials, threadId);
    return res?.ok === true;
  }

  async restoreThreadToInbox(mailbox: MailboxAccount, threadId: string): Promise<boolean> {
    const auth = await this.authFor(mailbox);
    if (!auth) return false;
    const res = await this.engine.restoreMailThreadToInbox(
      auth.provider,
      auth.credentials,
      threadId,
    );
    return res?.ok === true;
  }

  async setThreadRead(mailbox: MailboxAccount, threadId: string, read: boolean): Promise<boolean> {
    const auth = await this.authFor(mailbox);
    if (!auth) return false;
    const res = await this.engine.setMailThreadRead(
      auth.provider,
      auth.credentials,
      threadId,
      read,
    );
    return res?.ok === true;
  }

  /**
   * The AUTHORITATIVE linked address for (provider, owning user) — resolved from
   * the provider itself via the broker token, so a Gmail/M365 whose address
   * differs from the user's login identity registers correctly. null when the
   * account isn't connected / the engine is dormant (the caller falls back).
   */
  async resolveOwnAddress(provider: ExternalProvider, ucUid: string): Promise<string | null> {
    const credentials = await this.credentialsForUser(provider, ucUid);
    if (!credentials) return null;
    const profile = await this.engine.getAccountProfile(provider, credentials);
    const email = profile?.email?.trim().toLowerCase();
    return email || null;
  }

  // ── helpers ──

  private providerOf(mailbox: Pick<MailboxAccount, 'provider'>): ExternalProvider | null {
    return mailbox.provider === 'gmail' || mailbox.provider === 'microsoft'
      ? mailbox.provider
      : null;
  }

  private aliasFor(provider: ExternalProvider): 'google' | 'microsoft' {
    return provider === 'gmail' ? 'google' : 'microsoft';
  }

  private credentialsFor(provider: ExternalProvider, token: string): Record<string, unknown> {
    return provider === 'gmail' ? { token } : { access_token: token };
  }

  /** {credentials} for (provider, owning user keycloakId) via the KC broker, or null. */
  private async credentialsForUser(
    provider: ExternalProvider,
    ucUid: string | null,
  ): Promise<Record<string, unknown> | null> {
    if (!ucUid) return null;
    try {
      // The mailbox ownerKey is the owning user's identity, but depending on the
      // auth path that stamped it, it can be the uchub `sub` (keycloakId) OR the
      // local User.id. Resolve by EITHER so the broker token (keyed off the real
      // User row) is found regardless of which flavor was stored.
      const user = await this.prisma.user.findFirst({
        where: { OR: [{ keycloakId: ucUid }, { id: ucUid }] },
      });
      if (!user) return null;
      const token = await this.broker.getProviderAccessToken(user, this.aliasFor(provider));
      return token ? this.credentialsFor(provider, token) : null;
    } catch (err) {
      this.logger.warn(
        `credentialsForUser(${provider}, ${ucUid}) failed: ${(err as Error).message} — treating as not connected`,
      );
      return null;
    }
  }

  /** Resolve {provider, credentials} for a mailbox via the KC broker, or null. */
  private async authFor(
    mailbox: MailboxAccount,
  ): Promise<{ provider: ExternalProvider; credentials: Record<string, unknown> } | null> {
    const provider = this.providerOf(mailbox);
    if (!provider) return null;
    const credentials = await this.credentialsForUser(provider, mailbox.ownerKey);
    return credentials ? { provider, credentials } : null;
  }
}
