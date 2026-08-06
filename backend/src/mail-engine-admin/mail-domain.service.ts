import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { MailDomain, Prisma } from '@prisma/client';
import { domainToASCII } from 'url';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MailDomainService {
  constructor(private readonly prisma: PrismaService) {}

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

  private isDomainUniqueConflict(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      return false;
    }
    const target = error.meta?.target;
    return !Array.isArray(target) || target.includes('domain');
  }
}
