import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface NativeUnsubscribeHttpResult {
  accepted: boolean;
  status: number | null;
  detail: string;
}

/** Injectable boundary for RFC 8058 POSTs; tests replace this with a fake. */
export abstract class NativeUnsubscribeHttpPort {
  abstract postOneClick(url: string): Promise<NativeUnsubscribeHttpResult>;
}

@Injectable()
export class NativeUnsubscribeHttpClient extends NativeUnsubscribeHttpPort {
  constructor(private readonly config: ConfigService) {
    super();
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('NATIVE_UNSUBSCRIBE_TIMEOUT_MS');
    const parsed = raw ? Number(raw) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return 15_000;
    return Math.min(parsed, 15_000);
  }

  async postOneClick(url: string): Promise<NativeUnsubscribeHttpResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { accepted: false, status: null, detail: 'one-click URL is invalid' };
    }
    if (parsed.protocol !== 'https:') {
      return { accepted: false, status: null, detail: 'one-click URL is not HTTPS' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Email-Ops-Cleaner/0.2 (RFC8058 one-click)',
        },
        body: 'List-Unsubscribe=One-Click',
        // Match cleaner-engine/cleanup/unsubscribe.py: do not follow a 3xx.
        redirect: 'manual',
        signal: controller.signal,
      });
      const accepted = response.status >= 200 && response.status < 400;
      return {
        accepted,
        status: response.status,
        detail: accepted
          ? `one-click POST accepted (HTTP ${response.status})`
          : `one-click POST rejected (HTTP ${response.status})`,
      };
    } catch (error) {
      return {
        accepted: false,
        status: null,
        detail: `one-click POST failed: ${(error as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
