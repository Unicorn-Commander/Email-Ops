import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { EngineInboxStats } from './connected-accounts.types';

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
}
