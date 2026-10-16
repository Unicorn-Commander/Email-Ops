import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AgentActionKind, MailDomain, Prisma, WorkspaceRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import { promises as dns } from 'node:dns';
import { domainToASCII } from 'url';
import { BUSINESS_TIME_ZONE } from '../common/business-time';
import { PrismaService } from '../prisma/prisma.service';

export const MAIL_DOMAIN_DNS_RESOLVER = Symbol('MAIL_DOMAIN_DNS_RESOLVER');

export interface MailDomainDnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
}

export interface MailDomainVerificationChallenge {
  recordName: string;
  recordType: 'TXT';
  recordValue: string;
}

export interface MailDomainVerificationView {
  id: string;
  domain: string;
  verified: boolean;
  verificationRequestedAt: string | null;
  verifiedAt: string | null;
  lastVerificationCheckAt: string | null;
  lastVerificationError: string | null;
  recordName: string | null;
  recordType: 'TXT' | null;
  recordValue: string | null;
}

const MAX_VERIFICATION_ERROR_LENGTH = 500;
const verificationDnsResolver: MailDomainDnsResolver = {
  resolveTxt: (hostname) => dns.resolveTxt(hostname),
};

@Injectable()
export class MailDomainService {
  private readonly logger = new Logger(MailDomainService.name);
  private verificationSweepRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_DOMAIN_DNS_RESOLVER)
    private readonly resolver: MailDomainDnsResolver = verificationDnsResolver,
  ) {}

  /**
   * Claim a canonical domain for a workspace. The insert is globally unique;
   * on a uniqueness failure, the follow-up lookup remains workspace-scoped so
   * the competing tenant's row is never read or disclosed.
   */
  async bindDomain(workspaceId: string, ucUid: string | null, domain: string): Promise<MailDomain> {
    const canonical = this.canonicalDomain(domain);
    try {
      return await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
        tx.mailDomain.create({ data: { workspaceId, domain: canonical } }),
      );
    } catch (error) {
      if (!this.isDomainUniqueConflict(error)) throw error;
    }

    const owned = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.mailDomain.findFirst({ where: { workspaceId, domain: canonical } }),
    );
    if (owned) return owned;

    throw new ConflictException(
      `Mail domain "${canonical}" is already bound to another workspace.`,
    );
  }

  /** List only this workspace's domain bindings. */
  async listDomains(workspaceId: string, ucUid: string | null): Promise<MailDomain[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.mailDomain.findMany({
        where: { workspaceId },
        orderBy: { domain: 'asc' },
      }),
    );
  }

  /** List the workspace's domains with the public verification state. */
  async listDomainVerification(
    workspaceId: string,
    ucUid: string | null,
  ): Promise<MailDomainVerificationView[]> {
    const rows = await this.listDomains(workspaceId, ucUid);
    return rows.map((row) => this.verificationView(row));
  }

  /** Fetch one domain without disclosing a row from another workspace. */
  async getDomain(workspaceId: string, ucUid: string | null, id: string): Promise<MailDomain> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const row = await tx.mailDomain.findFirst({ where: { id, workspaceId } });
      if (!row) throw new NotFoundException('Mail domain not found in this workspace.');
      return row;
    });
  }

  /** Fetch the public verification projection for one workspace domain. */
  async getDomainVerification(
    workspaceId: string,
    ucUid: string | null,
    id: string,
  ): Promise<MailDomainVerificationView> {
    return this.verificationView(await this.getDomain(workspaceId, ucUid, id));
  }

  /** Start or rotate the DNS challenge. Only ADMIN and OWNER may mutate it. */
  async requestVerification(
    workspaceId: string,
    ucUid: string | null,
    role: WorkspaceRole,
    id: string,
  ): Promise<MailDomainVerificationChallenge> {
    this.assertVerificationRole(role);
    const token = randomBytes(32).toString('hex');
    const now = new Date();

    const row = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const existing = await tx.mailDomain.findFirst({ where: { id, workspaceId } });
      if (!existing) throw new NotFoundException('Mail domain not found in this workspace.');
      const updated = await tx.mailDomain.update({
        where: { id: existing.id },
        data: {
          verificationToken: token,
          verificationRequestedAt: now,
          lastVerificationError: null,
        },
      });
      await tx.agentActionEvent.create({
        data: {
          workspaceId,
          kind: AgentActionKind.MAIL_DOMAIN_VERIFICATION_REQUESTED,
          actorUcUid: ucUid,
          detail: `TXT verification challenge requested for ${updated.domain}`,
        },
      });
      return updated;
    });

    const challenge = this.challengeFor(row);
    if (!challenge) throw new Error('Mail domain verification challenge was not persisted.');
    return challenge;
  }

  /** Resolve the DNS challenge and update the durable verification state. */
  async checkVerification(
    workspaceId: string,
    ucUid: string | null,
    role: WorkspaceRole,
    id: string,
    now = new Date(),
  ): Promise<MailDomainVerificationView> {
    this.assertVerificationRole(role);
    return this.checkVerificationRecord(workspaceId, ucUid, id, now);
  }

  /** Daily system sweep. A failed re-check records an error but never un-verifies. */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, { timeZone: BUSINESS_TIME_ZONE })
  async scheduledVerificationSweep(): Promise<void> {
    if (this.verificationSweepRunning) return;
    this.verificationSweepRunning = true;
    try {
      const checked = await this.runVerificationSweep();
      if (checked > 0) this.logger.log(`mail-domain verification sweep: checked=${checked}`);
    } catch (error) {
      this.logger.warn(`mail-domain verification sweep failed: ${this.safeError(error)}`);
    } finally {
      this.verificationSweepRunning = false;
    }
  }

  /** One deterministic sweep pass, exposed for scheduler tests. */
  async runVerificationSweep(now = new Date()): Promise<number> {
    const rows = await this.prisma.systemClient.mailDomain.findMany({
      where: { verified: true },
      select: { id: true, workspaceId: true },
      take: 500,
    });
    let checked = 0;
    for (const row of rows) {
      try {
        await this.checkVerificationRecord(row.workspaceId, 'mail-domain-scheduler', row.id, now);
        checked += 1;
      } catch (error) {
        this.logger.warn(
          `mail-domain verification re-check failed for domain=${row.id}: ${this.safeError(error)}`,
        );
      }
    }
    return checked;
  }

  /** Fail closed unless the domain is visibly bound inside this workspace. */
  async assertWorkspaceOwnsDomain(
    workspaceId: string,
    ucUid: string | null,
    domain: string,
  ): Promise<MailDomain> {
    const canonical = this.canonicalDomain(domain);
    const owned = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.mailDomain.findFirst({ where: { workspaceId, domain: canonical } }),
    );
    if (!owned) {
      throw new ForbiddenException(`Mail domain "${canonical}" is not bound to this workspace.`);
    }
    return owned;
  }

  /** Extract and canonicalize the domain portion of a mailbox address. */
  domainOf(address: string): string {
    const value = address.trim();
    const at = value.lastIndexOf('@');
    if (at <= 0 || at === value.length - 1) {
      throw new BadRequestException(`Invalid mailbox address "${address}".`);
    }
    return this.canonicalDomain(value.slice(at + 1));
  }

  /** DNS-equivalent spellings must resolve to one binding key. */
  canonicalDomain(domain: string): string {
    const input = domain.trim().replace(/\.+$/, '').toLowerCase();
    const canonical = domainToASCII(input).toLowerCase();
    const labels = canonical.split('.');
    const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
    if (!canonical || canonical.length > 253 || labels.some((label) => !validLabel.test(label))) {
      throw new BadRequestException(`Invalid mail domain "${domain}".`);
    }
    return canonical;
  }

  /** Convert a Prisma row to the REST/MCP verification view without exposing the raw token. */
  verificationView(row: MailDomain): MailDomainVerificationView {
    const challenge = this.challengeFor(row);
    return {
      id: row.id,
      domain: row.domain,
      verified: row.verified,
      verificationRequestedAt: row.verificationRequestedAt?.toISOString() ?? null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastVerificationCheckAt: row.lastVerificationCheckAt?.toISOString() ?? null,
      lastVerificationError: row.lastVerificationError ?? null,
      recordName: challenge?.recordName ?? null,
      recordType: challenge?.recordType ?? null,
      recordValue: challenge?.recordValue ?? null,
    };
  }

  private async checkVerificationRecord(
    workspaceId: string,
    ucUid: string | null,
    id: string,
    now: Date,
  ): Promise<MailDomainVerificationView> {
    const row = await this.getDomain(workspaceId, ucUid, id);
    const recordName = this.recordName(row.domain);
    let matched = false;
    let error: string | null = null;

    if (!row.verificationToken) {
      error = 'No verification challenge has been requested.';
    } else {
      try {
        const records = await this.resolver.resolveTxt(recordName);
        const expected = `emailops-verify=${row.verificationToken}`;
        matched = records.some((record) => record.join('') === expected);
        if (!matched) {
          error = `TXT record ${recordName} did not contain the expected verification value.`;
        }
      } catch (dnsError) {
        error = this.safeError(dnsError);
      }
    }

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const updated = await tx.mailDomain.update({
        where: { id: row.id },
        data: {
          // A failed manual or scheduled re-check never revokes an existing
          // verification. A human must decide whether to change that state.
          verified: matched ? true : row.verified,
          verifiedAt: matched ? row.verifiedAt ?? now : row.verifiedAt,
          lastVerificationCheckAt: now,
          lastVerificationError: error,
        },
      });
      await tx.agentActionEvent.create({
        data: {
          workspaceId,
          kind: matched
            ? AgentActionKind.MAIL_DOMAIN_VERIFIED
            : AgentActionKind.MAIL_DOMAIN_VERIFICATION_FAILED,
          actorUcUid: ucUid,
          detail: matched
            ? `TXT verification matched for ${updated.domain}`
            : `TXT verification failed for ${updated.domain}: ${error}`,
        },
      });
      return this.verificationView(updated);
    });
  }

  private challengeFor(
    row: Pick<MailDomain, 'domain' | 'verificationToken'>,
  ): MailDomainVerificationChallenge | null {
    if (!row.verificationToken) return null;
    return {
      recordName: this.recordName(row.domain),
      recordType: 'TXT',
      recordValue: `emailops-verify=${row.verificationToken}`,
    };
  }

  private recordName(domain: string): string {
    return `_emailops-verify.${domain}`;
  }

  private assertVerificationRole(role: WorkspaceRole): void {
    if (role !== WorkspaceRole.ADMIN && role !== WorkspaceRole.OWNER) {
      throw new ForbiddenException('Mail domain verification requires workspace ADMIN or OWNER role.');
    }
  }

  private safeError(error: unknown): string {
    const value = error instanceof Error ? error.message : String(error);
    return value.slice(0, MAX_VERIFICATION_ERROR_LENGTH) || 'DNS lookup failed.';
  }

  private isDomainUniqueConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }
    const target = error.meta?.target;
    return !Array.isArray(target) || target.includes('domain');
  }
}
