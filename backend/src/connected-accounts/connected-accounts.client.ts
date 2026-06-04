import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { EngineInboxStats, EngineProfile } from './connected-accounts.types';

@Injectable()
export class CleanerEngineClient extends ConnectedAccountsEnginePort {
  private readonly logger = new Logger(CleanerEngineClient.name);

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.isConfigured()) {
      this.logger.warn(
        'CLEANER_ENGINE_URL / CLEANER_ENGINE_TOKEN unset — the Cleaner Engine is DORMANT; connected-account stats / analysis will degrade-clean until configured.',
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
      this.logger.warn(`Cleaner Engine text response parse error on ${path}: ${(err as Error).message}`);
      return null;
    }
  }

  private parseAnalyzePayload(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        return parsed;
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
        const payload = dataLines.join('\n');
        try {
          return JSON.parse(payload) as Record<string, unknown>;
        } catch (err) {
          this.logger.warn(`Cleaner Engine analyze SSE parse error: ${(err as Error).message}`);
          return null;
        }
      }
    }
    return null;
  }

  async getOAuthUrl(provider: string, redirectUri: string): Promise<string | null> {
    const payload = await this.postJson<{ url?: unknown }>('/auth/oauth-url', {
      provider,
      redirect_uri: redirectUri,
    });
    return payload && typeof payload.url === 'string' ? payload.url : null;
  }

  async exchangeCode(
    provider: string,
    code: string,
    redirectUri: string,
  ): Promise<Record<string, unknown> | null> {
    return this.postJson<Record<string, unknown>>('/auth/exchange', {
      provider,
      code,
      redirect_uri: redirectUri,
    });
  }

  async getProfile(
    provider: string,
    credentials: Record<string, unknown>,
  ): Promise<EngineProfile | null> {
    return this.postJson<EngineProfile>('/accounts/profile', { provider, credentials });
  }

  async getInboxStats(
    provider: string,
    credentials: Record<string, unknown>,
  ): Promise<EngineInboxStats | null> {
    return this.postJson<EngineInboxStats>('/accounts/stats', { provider, credentials });
  }

  async analyzeInbox(
    provider: string,
    credentials: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const raw = await this.postText('/ai/analyze', { provider, credentials });
    if (!raw) return null;
    const parsed = this.parseAnalyzePayload(raw);
    if (!parsed) {
      this.logger.warn('Cleaner Engine analyze response could not be parsed');
    }
    return parsed;
  }
}
