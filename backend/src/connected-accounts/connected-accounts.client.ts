import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import {
  EngineBackupManifest,
  EngineArchiveRef,
  EngineArchiveRestoreResult,
  EngineArchiveVerifyResult,
  EngineAccountProfile,
  EngineInboxStats,
  EngineListMessagesResult,
  EngineMailFolder,
  EngineMailSendResult,
  EngineMailThreadActionResult,
  EngineMailThreadResult,
  EngineMailThreadsResult,
  EngineMessageSummary,
} from './connected-accounts.types';

@Injectable()
export class CleanerEngineClient extends ConnectedAccountsEnginePort {
  private readonly logger = new Logger(CleanerEngineClient.name);

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.isConfigured()) {
      this.logger.warn(
        'CLEANER_ENGINE_URL / CLEANER_ENGINE_TOKEN unset — the Cleaner Engine is DORMANT; inbox stats / analysis will degrade-clean until configured.',
      );
    } else {
      this.logger.log(`Cleaner Engine target: ${this.baseUrl}`);
    }
  }

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('CLEANER_ENGINE_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get token(): string | null {
    const raw = this.config.get<string>('CLEANER_ENGINE_TOKEN');
    return raw && raw.trim() ? raw.trim() : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('CLEANER_ENGINE_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  isConfigured(): boolean {
    return this.baseUrl !== null && this.token !== null;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Engine-Token': this.token ?? '',
    };
  }

  private endpoint(path: string): string | null {
    const base = this.baseUrl;
    if (!base) return null;
    return new URL(path.replace(/^\//, ''), `${base}/`).toString().replace(/\/$/, '');
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

  private async postJson<T>(path: string, body: unknown): Promise<T | null> {
    const url = this.endpoint(path);
    if (!url || !this.token) return null;

    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Cleaner Engine transport error on ${path}: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Cleaner Engine HTTP ${res.status} on ${path}`);
      return null;
    }

    try {
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`Cleaner Engine non-JSON response on ${path}: ${(err as Error).message}`);
      return null;
    }
  }

  private async postText(path: string, body: unknown): Promise<string | null> {
    const url = this.endpoint(path);
    if (!url || !this.token) return null;

    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.warn(`Cleaner Engine transport error on ${path}: ${(err as Error).message}`);
      return null;
    }

    if (!res.ok) {
      this.logger.warn(`Cleaner Engine HTTP ${res.status} on ${path}`);
      return null;
    }

    try {
      return await res.text();
    } catch (err) {
      this.logger.warn(`Cleaner Engine text parse error on ${path}: ${(err as Error).message}`);
      return null;
    }
  }

  async getInboxStats(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
  ): Promise<EngineInboxStats | null> {
    return this.postJson<EngineInboxStats>('/accounts/stats', { provider, credentials });
  }

  /**
   * Conversational assistant turn — forwards a user message plus a context blob
   * (current mailbox/folder/thread digest) to the engine's LLM chat endpoint.
   * Returns the assistant text, or null when the engine/gateway is dormant.
   */
  async chat(message: string, context: Record<string, unknown> = {}): Promise<string | null> {
    const res = await this.postJson<{ response?: string }>('/ai/chat', { message, context });
    return res?.response ?? null;
  }

  /**
   * Streaming chat — POSTs to the engine's SSE endpoint and returns the raw Response
   * so the controller can proxy the `token`/`actions`/`done` frames to the browser.
   * Deliberately bypasses `fetchWithTimeout` (a long stream must not be aborted at
   * the 10s buffered-request timeout); returns null when the engine is dormant.
   */
  async chatStream(
    message: string,
    context: Record<string, unknown> = {},
  ): Promise<Response | null> {
    const url = this.endpoint('/ai/chat/stream');
    if (!url || !this.token) return null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        body: JSON.stringify({ message, context }),
      });
      if (!res.ok) {
        this.logger.warn(`Cleaner Engine HTTP ${res.status} on /ai/chat/stream`);
        return null;
      }
      return res;
    } catch (err) {
      this.logger.warn(
        `Cleaner Engine transport error on /ai/chat/stream: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async analyzeInbox(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const raw = await this.postText('/ai/analyze', { provider, credentials });
    if (!raw) return null;

    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed) as Record<string, unknown>;
      } catch (err) {
        this.logger.warn(`Cleaner Engine analyze JSON parse error: ${(err as Error).message}`);
        return null;
      }
    }

    const blocks = trimmed.split(/\n\s*\n/).reverse();
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      let eventName = '';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (eventName === 'result' && dataLines.length > 0) {
        try {
          return JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
        } catch (err) {
          this.logger.warn(`Cleaner Engine analyze SSE parse error: ${(err as Error).message}`);
          return null;
        }
      }
    }

    this.logger.warn('Cleaner Engine analyze response could not be parsed');
    return null;
  }

  async listMessages(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    query = '',
    maxResults = 100,
    pageToken: string | null = null,
  ): Promise<EngineListMessagesResult | null> {
    return this.postJson<EngineListMessagesResult>('/messages/list', {
      provider,
      credentials,
      query,
      max_results: maxResults,
      page_token: pageToken,
    });
  }

  async getMessage(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageId: string,
    format: 'metadata' | 'full' | 'minimal' = 'metadata',
  ): Promise<EngineMessageSummary | null> {
    return this.postJson<EngineMessageSummary>('/messages/get', {
      provider,
      credentials,
      message_id: messageId,
      format,
    });
  }

  async batchTrash(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
  ): Promise<{ count: number } | null> {
    return this.postJson<{ count: number }>('/cleanup/trash', {
      provider,
      credentials,
      message_ids: messageIds,
    });
  }

  async batchDelete(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
  ): Promise<{ count: number } | null> {
    return this.postJson<{ count: number }>('/cleanup/delete', {
      provider,
      credentials,
      message_ids: messageIds,
    });
  }

  async batchArchive(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
    label?: string | null,
  ): Promise<{ count: number } | null> {
    return this.postJson<{ count: number }>('/cleanup/organize', {
      provider,
      credentials,
      message_ids: messageIds,
      label: label ?? null,
    });
  }

  async archiveCreate(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    messageIds: string[],
    garage: { bucket: string; key_prefix: string },
    options: { query?: string; workspaceId?: string; expiresAt?: string | null } = {},
  ): Promise<EngineArchiveRef | null> {
    return this.postJson<EngineArchiveRef>('/archive/create', {
      provider,
      credentials,
      message_ids: messageIds,
      garage,
      query: options.query ?? '',
      workspace_id: options.workspaceId,
      expires_at: options.expiresAt ?? null,
    });
  }

  async archiveVerify(bucket: string, key: string): Promise<EngineArchiveVerifyResult | null> {
    return this.postJson<EngineArchiveVerifyResult>('/archive/verify', { bucket, key });
  }

  async archiveRestore(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    bucket: string,
    key: string,
  ): Promise<EngineArchiveRestoreResult | null> {
    return this.postJson<EngineArchiveRestoreResult>('/archive/restore', {
      provider,
      credentials,
      bucket,
      key,
    });
  }

  async backupCreate(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    query: string,
    path: string,
  ): Promise<EngineBackupManifest | null> {
    return this.postJson<EngineBackupManifest>('/backup/create', {
      provider,
      credentials,
      query,
      path,
    });
  }

  async backupVerify(path: string): Promise<Record<string, unknown> | null> {
    return this.postJson<Record<string, unknown>>('/backup/verify', { path });
  }

  // ── Unified-inbox verbs (degrade-clean: null on dormant/transport/HTTP error) ──

  async getAccountProfile(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
  ): Promise<EngineAccountProfile | null> {
    return this.postJson<EngineAccountProfile>('/accounts/profile', { provider, credentials });
  }

  async listMailThreads(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    folder: EngineMailFolder,
    limit = 50,
  ): Promise<EngineMailThreadsResult | null> {
    return this.postJson<EngineMailThreadsResult>('/mail/threads', {
      provider,
      credentials,
      folder,
      limit,
    });
  }

  async getMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadResult | null> {
    return this.postJson<EngineMailThreadResult>('/mail/thread', {
      provider,
      credentials,
      thread_id: threadId,
    });
  }

  // Thread-level triage verbs. The thread id rides in the PATH (the engine's
  // /mail/threads/{id}/... routes), so encode it — Microsoft conversation ids
  // are base64 and may contain '/' or '='.

  async archiveMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null> {
    return this.postJson<EngineMailThreadActionResult>(
      `/mail/threads/${encodeURIComponent(threadId)}/archive`,
      { provider, credentials },
    );
  }

  async trashMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null> {
    return this.postJson<EngineMailThreadActionResult>(
      `/mail/threads/${encodeURIComponent(threadId)}/trash`,
      { provider, credentials },
    );
  }

  async spamMailThread(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null> {
    return this.postJson<EngineMailThreadActionResult>(
      `/mail/threads/${encodeURIComponent(threadId)}/spam`,
      { provider, credentials },
    );
  }

  async restoreMailThreadToInbox(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
  ): Promise<EngineMailThreadActionResult | null> {
    return this.postJson<EngineMailThreadActionResult>(
      `/mail/threads/${encodeURIComponent(threadId)}/inbox`,
      { provider, credentials },
    );
  }

  async setMailThreadRead(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    threadId: string,
    read: boolean,
  ): Promise<EngineMailThreadActionResult | null> {
    return this.postJson<EngineMailThreadActionResult>(
      `/mail/threads/${encodeURIComponent(threadId)}/read`,
      { provider, credentials, read },
    );
  }

  async sendMail(
    provider: 'gmail' | 'microsoft',
    credentials: Record<string, unknown>,
    message: {
      from: string;
      to: string;
      subject: string;
      body: string;
      inReplyToThreadId?: string | null;
    },
  ): Promise<EngineMailSendResult | null> {
    return this.postJson<EngineMailSendResult>('/mail/send', {
      provider,
      credentials,
      from: message.from,
      to: message.to,
      subject: message.subject,
      body: message.body,
      in_reply_to_thread_id: message.inReplyToThreadId ?? null,
    });
  }
}
