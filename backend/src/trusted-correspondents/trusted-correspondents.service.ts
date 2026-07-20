/**
 * TrustedCorrespondentsService — the CRUD surface over the Wave-7 trusted-
 * correspondent table (the OUTBOUND "ongoing conversation" allowlist the agent
 * autonomy matrix consults for L2 external auto-sends).
 *
 * Learning happens elsewhere (EmailService.approveAgentInboxItem upserts on
 * approval); this service is the human/agent management surface: list, add
 * MANUALLY, remove. One implementation behind both the REST controller and the
 * MCP tools — one set of rules, one RLS path (every method runs inside
 * withWorkspace with an explicit workspaceId predicate, the same
 * defense-in-depth as the other scoped tables).
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TrustedCorrespondentScope, TrustedCorrespondentSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeAddress } from '../email/autonomy';
import { TrustedCorrespondentView } from '../email/email.types';

/** The same pragmatic address shape the compose contact-capture accepts. */
const ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A bare domain (no '@'): at least one dot-separated label pair. */
const DOMAIN_RE = /^[^\s@]+\.[^\s@]+$/;

/**
 * Resolve a raw trust token to its normalized (value, scope). An explicit
 * `scope` wins; otherwise infer — an '@'-bearing token is an ADDRESS, a bare
 * `acme.com` (or a leading-'@' `@acme.com`) is a DOMAIN. Throws on anything
 * that is neither a valid address nor a valid domain.
 */
export function resolveTrustTarget(
  raw: string,
  scope?: 'address' | 'domain' | null,
): { value: string; scope: TrustedCorrespondentScope } {
  // normalizeAddress also extracts the address from a "Name <addr>" form, so an
  // address is recognized even when wrapped. A value that doesn't normalize to a
  // valid address (bare acme.com, leading-'@' @acme.com) is treated as a DOMAIN.
  const address = normalizeAddress(raw);
  const isAddress = ADDRESS_RE.test(address);
  const wantsDomain = scope === 'domain' || (!scope && !isAddress);
  if (wantsDomain) {
    const domain = (raw ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!DOMAIN_RE.test(domain)) {
      throw new BadRequestException('A valid domain (e.g. acme.com) is required.');
    }
    return { value: domain, scope: TrustedCorrespondentScope.DOMAIN };
  }
  if (!isAddress) {
    throw new BadRequestException('A valid email address is required.');
  }
  return { value: address, scope: TrustedCorrespondentScope.ADDRESS };
}

@Injectable()
export class TrustedCorrespondentsService {
  private readonly logger = new Logger(TrustedCorrespondentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every trusted correspondent in the workspace, newest-first. */
  async list(workspaceId: string, ucUid: string | null): Promise<TrustedCorrespondentView[]> {
    const rows = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.trustedCorrespondent.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    );
    return rows.map((r) => this.view(r));
  }

  /**
   * Manually trust an address (source MANUAL). Idempotent: re-trusting an
   * existing row just refreshes the note. The address is normalized (bare,
   * lowercased) exactly as the gate compares it.
   */
  async add(
    workspaceId: string,
    ucUid: string | null,
    input: { address: string; note?: string | null; scope?: 'address' | 'domain' | null },
  ): Promise<TrustedCorrespondentView> {
    const { value: address, scope } = resolveTrustTarget(input.address, input.scope);
    const note = (input.note ?? '').trim().slice(0, 500) || null;
    const row = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.trustedCorrespondent.upsert({
        where: { workspaceId_scope_address: { workspaceId, scope, address } },
        create: {
          workspaceId,
          address,
          scope,
          source: TrustedCorrespondentSource.MANUAL,
          addedByUcUid: ucUid,
          note,
        },
        update: { ...(note ? { note } : {}) },
      }),
    );
    this.logger.log(
      `trusted correspondent ${address} (${scope}) added manually by ${ucUid ?? '(unknown)'} (workspace ${workspaceId})`,
    );
    return this.view(row);
  }

  /** Untrust by row id. False when the id is unknown/foreign (→ 404 upstream). */
  async remove(workspaceId: string, ucUid: string | null, id: string): Promise<boolean> {
    const res = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      // Fenced delete: a foreign id matches zero rows — never a cross-tenant probe.
      tx.trustedCorrespondent.deleteMany({ where: { id, workspaceId } }),
    );
    return res.count > 0;
  }

  /**
   * Untrust by address OR bare domain (the MCP-friendly natural key). A leading
   * '@' is stripped so untrusting '@acme.com' targets the DOMAIN row; the delete
   * matches the stored value across either scope.
   */
  async removeByAddress(
    workspaceId: string,
    ucUid: string | null,
    rawAddress: string,
  ): Promise<boolean> {
    const address = normalizeAddress(rawAddress).replace(/^@/, '');
    if (!address) return false;
    const res = await this.prisma.withWorkspace(workspaceId, ucUid, (tx) =>
      tx.trustedCorrespondent.deleteMany({ where: { workspaceId, address } }),
    );
    return res.count > 0;
  }

  private view(r: {
    id: string;
    address: string;
    scope: TrustedCorrespondentScope;
    source: TrustedCorrespondentSource;
    approvalCount: number;
    lastApprovedAt: Date | null;
    addedByUcUid: string | null;
    note: string | null;
    createdAt: Date;
  }): TrustedCorrespondentView {
    return {
      id: r.id,
      address: r.address,
      scope: r.scope,
      source: r.source,
      approvalCount: r.approvalCount,
      lastApprovedAt: r.lastApprovedAt ? r.lastApprovedAt.toISOString() : null,
      addedByUcUid: r.addedByUcUid ?? null,
      note: r.note ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    };
  }
}
