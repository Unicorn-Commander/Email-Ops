/**
 * JamesAdminClient — the concrete mail-engine ADMIN client, speaking Apache
 * James' WebAdmin REST API.
 *
 * This is the control-plane counterpart to the data-plane mail client: it mints
 * and removes the real engine objects (domains, accounts, mailboxes, quotas,
 * aliases) behind Email-Ops' MailboxAccount SoR. James exposes all of it over a
 * clean REST surface (PUT/GET/DELETE on /domains, /users, /quota, /address/...),
 * which is exactly why James was chosen for the agent-manageable migration —
 * `provisionMailbox` becomes a real mailbox, not just a registry row.
 *
 * DEGRADE-CLEAN (binding): when JAMES_WEBADMIN_URL is unset, `isConfigured()` is
 * false and every method returns `provisioned:false` (or []) WITHOUT a network
 * call and NEVER throws. Every method is also individually safe when a single
 * call fails (transport error / non-2xx → reported, not thrown). Operations are
 * idempotent: re-provisioning an existing object reports success.
 *
 * Auth: WebAdmin runs either unauthenticated (trusted-network / loopback dev) or
 * behind a JWT. When JAMES_WEBADMIN_JWT is set it is sent as a Bearer token.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import {
  EngineAccountInfo,
  EngineDomainInfo,
  EngineProvisionResult,
  MailEngineAdminPort,
} from './mail-engine-admin.port';
import { DEFAULT_MAILBOX_QUOTA_BYTES } from './mail-engine-admin.constants';

/** The standard mailboxes minted on a fresh account (parity with the suite UI). */
const STANDARD_MAILBOXES = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Archive', 'Spam'];

@Injectable()
export class JamesAdminClient extends MailEngineAdminPort {
  private readonly logger = new Logger(JamesAdminClient.name);

  constructor(private readonly config: ConfigService) {
    super();
    if (!this.isConfigured()) {
      this.logger.warn(
        'JAMES_WEBADMIN_URL unset — the James admin engine is DORMANT; mailbox ' +
          'provisioning records the SoR row but does NOT mint a real engine account ' +
          '(provisionState stays REGISTERED). Set JAMES_WEBADMIN_URL to light it up.',
      );
    } else {
      this.logger.log(
        `James admin engine target: ${this.baseUrl} ` +
          `(auth: ${this.jwt ? 'JWT' : 'none/trusted-network'})`,
      );
    }
  }

  // --- configuration seam -------------------------------------------------

  private get baseUrl(): string | null {
    const raw = this.config.get<string>('JAMES_WEBADMIN_URL');
    return raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
  }

  private get jwt(): string | null {
    const raw = this.config.get<string>('JAMES_WEBADMIN_JWT');
    return raw && raw.trim() ? raw.trim() : null;
  }

  private get timeoutMs(): number {
    const raw = this.config.get<string>('JAMES_ADMIN_TIMEOUT_MS');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10000;
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  // --- transport ----------------------------------------------------------

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    const token = this.jwt;
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
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
   * Issue a WebAdmin request. Returns the Response on a completed round-trip
   * (any status), or null on a transport/timeout error (logged). Never throws.
   */
  private async req(
    method: string,
    path: string,
    body?: unknown,
    rawBody?: string,
  ): Promise<Response | null> {
    const base = this.baseUrl;
    if (!base) return null;
    const json = body !== undefined;
    const init: RequestInit = { method, headers: this.headers(json || rawBody !== undefined) };
    if (rawBody !== undefined) init.body = rawBody;
    else if (json) init.body = JSON.stringify(body);
    try {
      return await this.fetchWithTimeout(`${base}${path}`, init);
    } catch (err) {
      this.logger.warn(`James WebAdmin ${method} ${path} transport error: ${(err as Error).message}`);
      return null;
    }
  }

  /** A 2xx (or an "already exists" 409) is treated as an idempotent success. */
  private ok(res: Response | null, idempotentConflict = false): boolean {
    if (!res) return false;
    if (res.ok) return true;
    if (idempotentConflict && res.status === 409) return true;
    return false;
  }

  private result(res: Response | null, what: string, idempotentConflict = false): EngineProvisionResult {
    if (this.ok(res, idempotentConflict)) return { provisioned: true, reason: null };
    const reason = res ? `${what} → HTTP ${res.status}` : `${what} → transport error`;
    this.logger.warn(`James admin: ${reason}`);
    return { provisioned: false, reason };
  }

  private seg(s: string): string {
    return encodeURIComponent(s);
  }

  private domainOf(address: string): string | null {
    const at = address.lastIndexOf('@');
    if (at <= 0 || at === address.length - 1) return null;
    return address.slice(at + 1);
  }

  private genPassword(): string {
    return randomBytes(24).toString('base64url');
  }

  // --- MailEngineAdminPort implementation ---------------------------------

  async ensureDomain(domain: string): Promise<EngineProvisionResult> {
    if (!this.isConfigured()) return { provisioned: false, reason: 'james admin not configured' };
    const res = await this.req('PUT', `/domains/${this.seg(domain)}`);
    return this.result(res, `ensureDomain(${domain})`, true);
  }

  async removeDomain(domain: string): Promise<EngineProvisionResult> {
    if (!this.isConfigured()) return { provisioned: false, reason: 'james admin not configured' };
    const res = await this.req('DELETE', `/domains/${this.seg(domain)}`);
    return this.result(res, `removeDomain(${domain})`, true);
  }

  async listDomains(): Promise<EngineDomainInfo[]> {
    const res = await this.req('GET', '/domains');
    if (!res || !res.ok) return [];
    try {
      const arr = (await res.json()) as unknown;
      if (!Array.isArray(arr)) return [];
      return arr.filter((d): d is string => typeof d === 'string').map((domain) => ({ domain }));
    } catch {
      return [];
    }
  }

  async ensureAccount(
    address: string,
    opts?: { password?: string | null; quotaBytes?: number | null },
  ): Promise<EngineProvisionResult> {
    if (!this.isConfigured()) return { provisioned: false, reason: 'james admin not configured' };
    const domain = this.domainOf(address);
    if (!domain) return { provisioned: false, reason: `invalid address "${address}"` };

    // Best-effort: ensure the domain exists first (James rejects users on an
    // unknown domain). A domain failure surfaces as the account failure below.
    await this.ensureDomain(domain);

    const password = opts?.password ?? this.genPassword();
    const userRes = await this.req('PUT', `/users/${this.seg(address)}`, { password });
    const userResult = this.result(userRes, `ensureAccount(${address})`, true);
    if (!userResult.provisioned) return userResult;

    // Pre-create the standard mailboxes (best-effort; INBOX is auto-made on first
    // login, but we want the full folder set visible immediately). Failures here
    // do not fail the account — it exists and is usable.
    for (const mb of STANDARD_MAILBOXES) {
      await this.req('PUT', `/users/${this.seg(address)}/mailboxes/${this.seg(mb)}`);
    }

    const quotaBytes =
      opts?.quotaBytes === undefined ? DEFAULT_MAILBOX_QUOTA_BYTES : opts.quotaBytes;
    if (quotaBytes != null) {
      await this.setQuota(address, quotaBytes);
    }
    return { provisioned: true, reason: null };
  }

  async removeAccount(address: string): Promise<EngineProvisionResult> {
    if (!this.isConfigured()) return { provisioned: false, reason: 'james admin not configured' };
    const res = await this.req('DELETE', `/users/${this.seg(address)}`);
    return this.result(res, `removeAccount(${address})`, true);
  }

  async listAccounts(): Promise<EngineAccountInfo[]> {
    const res = await this.req('GET', '/users');
    if (!res || !res.ok) return [];
    try {
      const arr = (await res.json()) as unknown;
      if (!Array.isArray(arr)) return [];
      const out: EngineAccountInfo[] = [];
      for (const u of arr) {
        const username = (u as Record<string, unknown>)?.['username'];
        if (typeof username === 'string' && username) out.push({ address: username });
      }
      return out;
    } catch {
      return [];
    }
  }

  async setQuota(address: string, quotaBytes: number | null): Promise<EngineProvisionResult> {
    if (!this.isConfigured()) return { provisioned: false, reason: 'james admin not configured' };
    if (quotaBytes == null) {
      const res = await this.req('DELETE', `/quota/users/${this.seg(address)}/size`);
      return this.result(res, `clearQuota(${address})`, true);
    }
    // WebAdmin takes the size as a raw integer body on PUT .../size.
    const res = await this.req('PUT', `/quota/users/${this.seg(address)}/size`, undefined, String(Math.floor(quotaBytes)));
    return this.result(res, `setQuota(${address})`);
  }

  async addAlias(source: string, destination: string): Promise<EngineProvisionResult> {
    if (!this.isConfigured()) return { provisioned: false, reason: 'james admin not configured' };
    // James: PUT /address/aliases/{destination}/sources/{source} — mail to
    // `source` is delivered to `destination`.
    const res = await this.req(
      'PUT',
      `/address/aliases/${this.seg(destination)}/sources/${this.seg(source)}`,
    );
    return this.result(res, `addAlias(${source} -> ${destination})`, true);
  }

  async removeAlias(source: string, destination: string): Promise<EngineProvisionResult> {
    if (!this.isConfigured()) return { provisioned: false, reason: 'james admin not configured' };
    const res = await this.req(
      'DELETE',
      `/address/aliases/${this.seg(destination)}/sources/${this.seg(source)}`,
    );
    return this.result(res, `removeAlias(${source} -> ${destination})`, true);
  }
}
