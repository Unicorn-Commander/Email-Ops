import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type CalendarBridgePurpose = 'device' | 'backend';

export interface CalendarBridgeCreatedKey {
  app_id: string;
  secret: string;
  username: string;
  expires_at: string;
}

export interface CalendarBridgeListedKey {
  name: string;
  app_id: string;
  scope: string[];
  created_at: string;
  last_used_at: string | null;
  used_as: string;
  status: string;
}

export class CalendarBridgeError extends Error {
  constructor(
    public readonly status: number,
    message = 'Calendar bridge request failed.',
  ) {
    super(message);
    this.name = 'CalendarBridgeError';
  }
}

/**
 * Small HTTP client for the private Davis bridge. It intentionally never
 * includes a response body or credential material in an exception message.
 */
@Injectable()
export class CalendarBridgeClient {
  private readonly baseUrl: string | null;
  private readonly token: string | null;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    const rawUrl = config.get<string>('CALENDAR_BRIDGE_URL')?.trim() ?? '';
    const rawToken = config.get<string>('CALENDAR_BRIDGE_TOKEN')?.trim() ?? '';
    this.token = rawToken || null;
    this.timeoutMs = Math.min(
      10_000,
      Math.max(500, Number(config.get<string>('CALENDAR_BRIDGE_TIMEOUT_MS', '5000')) || 5000),
    );

    if (!rawUrl || !rawToken) {
      this.baseUrl = null;
      return;
    }

    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
      url.pathname = url.pathname.replace(/\/+$/, '');
      this.baseUrl = url.toString().replace(/\/$/, '');
    } catch {
      this.baseUrl = null;
    }
  }

  isConfigured(): boolean {
    return this.baseUrl !== null && this.token !== null;
  }

  async createKey(
    input: {
      login: string;
      label: string;
      purpose: CalendarBridgePurpose;
      ttl_seconds: number;
    },
    idempotencyKey: string,
  ): Promise<CalendarBridgeCreatedKey> {
    const result = await this.request<unknown>('/v1/keys', {
      method: 'POST',
      idempotencyKey,
      body: input,
    });
    if (
      !isRecord(result) ||
      !isString(result.app_id) ||
      !isString(result.secret) ||
      !isString(result.username) ||
      !isString(result.expires_at)
    ) {
      throw new CalendarBridgeError(502);
    }
    return {
      app_id: result.app_id,
      secret: result.secret,
      username: result.username,
      expires_at: result.expires_at,
    };
  }

  async listKeys(login: string): Promise<CalendarBridgeListedKey[]> {
    const result = await this.request<unknown>(`/v1/keys?login=${encodeURIComponent(login)}`, {
      method: 'GET',
    });
    if (!isRecord(result) || !Array.isArray(result.items)) throw new CalendarBridgeError(502);
    if (!result.items.every(isListedKey)) throw new CalendarBridgeError(502);
    return result.items;
  }

  async revokeKey(appId: string): Promise<{ confirmed: boolean }> {
    const result = await this.request<unknown>(`/v1/keys/${encodeURIComponent(appId)}`, {
      method: 'DELETE',
    });
    if (!isRecord(result) || result.app_id !== appId || result.confirmed !== true) {
      throw new CalendarBridgeError(502);
    }
    return { confirmed: true };
  }

  private async request<T>(
    path: string,
    options: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown; idempotencyKey?: string },
  ): Promise<T> {
    if (!this.isConfigured())
      throw new CalendarBridgeError(503, 'Calendar bridge is not configured.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new CalendarBridgeError(response.status);
      try {
        return (await response.json()) as T;
      } catch {
        throw new CalendarBridgeError(502);
      }
    } catch (error) {
      if (error instanceof CalendarBridgeError) throw error;
      throw new CalendarBridgeError(503);
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isListedKey(value: unknown): value is CalendarBridgeListedKey {
  if (!isRecord(value)) return false;
  return (
    isString(value.name) &&
    isString(value.app_id) &&
    Array.isArray(value.scope) &&
    value.scope.every(isString) &&
    isString(value.created_at) &&
    (value.last_used_at === null || isString(value.last_used_at)) &&
    isString(value.used_as) &&
    isString(value.status)
  );
}
