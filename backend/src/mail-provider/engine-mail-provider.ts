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
import { MailFolder, MessageView, ThreadView } from '../email/email.types';
import {
  MailProviderPort,
  MailProviderSendRequest,
  MailProviderSendResult,
} from './mail-provider.port';

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
    opts: { folder: MailFolder; limit: number },
  ): Promise<ThreadView[]> {
    const auth = await this.authFor(mailbox);
    if (!auth) return [];
    const res = await this.engine.listMailThreads(
      auth.provider,
      auth.credentials,
      opts.folder,
      opts.limit,
    );
    if (!res) return [];
    return res.threads.map((t) => ({
      id: t.id,
      subject: t.subject,
      message_count: t.message_count,
      unread: t.unread,
      last_message_at: t.last_message_at,
      last_snippet: t.last_snippet,
      participants: t.participants.map((p) => ({ address: p.address, name: p.name })),
    }));
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

  /** Resolve {provider, credentials} via the KC broker, or null (degrade-clean). */
  private async authFor(
    mailbox: MailboxAccount,
  ): Promise<{ provider: ExternalProvider; credentials: Record<string, unknown> } | null> {
    const provider = this.providerOf(mailbox);
    if (!provider || !mailbox.ownerKey) return null;
    try {
      const user = await this.prisma.user.findUnique({ where: { keycloakId: mailbox.ownerKey } });
      if (!user) return null;
      const token = await this.broker.getProviderAccessToken(user, this.aliasFor(provider));
      if (!token) return null;
      return { provider, credentials: this.credentialsFor(provider, token) };
    } catch (err) {
      this.logger.warn(
        `authFor(${mailbox.emailAddress}) failed: ${(err as Error).message} — treating as not connected`,
      );
      return null;
    }
  }
}
