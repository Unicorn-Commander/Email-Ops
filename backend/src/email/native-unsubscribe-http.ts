import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * A List-Unsubscribe URL is attacker-controlled input (anyone who can e-mail the
 * mailbox chooses it), and the one-click POST leaves from inside our network. Refuse
 * every destination that is not a public unicast address: loopback, RFC 1918,
 * link-local (incl. the cloud metadata address), CGNAT / tailnet 100.64/10,
 * multicast, reserved, IPv6 unique-local / link-local and IPv4-mapped forms.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
    return true;
  }
  if (family === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return false;
    if (low.startsWith('fc') || low.startsWith('fd')) return false; // fc00::/7
    if (
      low.startsWith('fe8') ||
      low.startsWith('fe9') ||
      low.startsWith('fea') ||
      low.startsWith('feb')
    )
      return false; // fe80::/10
    if (low.startsWith('ff')) return false; // multicast
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}

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

  /** Resolution seam: tests override it; production uses the system resolver. */
  protected lookupHost(host: string): Promise<Array<{ address: string; family: number }>> {
    return lookup(host, { all: true });
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
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!host || host.toLowerCase() === 'localhost' || host.endsWith('.localhost')) {
      return { accepted: false, status: null, detail: 'one-click URL host is not public' };
    }
    try {
      const addresses = isIP(host) ? [host] : (await this.lookupHost(host)).map((a) => a.address);
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
        return { accepted: false, status: null, detail: 'one-click URL host is not public' };
      }
    } catch (error) {
      return {
        accepted: false,
        status: null,
        detail: `one-click URL host did not resolve: ${(error as Error).message}`,
      };
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
