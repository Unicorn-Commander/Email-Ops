/**
 * SenderPolicyService — the per-workspace sender block/allow list.
 *
 * The app enforces this on triage + display today and FEEDS it to the mail
 * engine's inbound filter once live (the engine is the real gate; this is the
 * policy the app teaches it). A BLOCK routes a sender to Spam; an ALLOW marks it
 * trusted (never-spam, overriding the engine score). Scope is an exact ADDRESS or
 * a whole DOMAIN — `evaluate` checks the exact address first, then the domain.
 *
 * Every method is workspace-scoped (explicit predicate + withWorkspace) — RLS is
 * inert under today's owner role, so the predicate is the real fence.
 */

import { Injectable } from '@nestjs/common';
import { SenderPolicy, SenderPolicyKind, SenderPolicyScope } from '@prisma/client';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { SenderPolicyView, SetSenderPolicyInput } from './mail-triage.types';

@Injectable()
export class SenderPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Normalize a raw match value for a scope (lowercase; strip a leading '@' on a domain). */
  normalize(scope: SenderPolicyScope, raw: string): string {
    const v = (raw ?? '').trim().toLowerCase();
    return scope === SenderPolicyScope.DOMAIN ? v.replace(/^@/, '') : v;
  }

  /** The domain portion of an address (lowercased), or null. */
  private domainOf(address: string | null): string | null {
    if (!address) return null;
    const at = address.lastIndexOf('@');
    if (at < 0 || at === address.length - 1) return null;
    return address.slice(at + 1).trim().toLowerCase();
  }

  /**
   * The effective verdict for a sender address (exact ADDRESS wins over DOMAIN).
   * tx-based so the inbound-classify path can call it inside its own withWorkspace.
   * Returns null when no rule matches.
   */
  async evaluate(
    tx: WorkspaceTxClient,
    workspaceId: string,
    fromAddress: string | null,
  ): Promise<SenderPolicyKind | null> {
    if (!fromAddress) return null;
    const address = fromAddress.trim().toLowerCase();
    const domain = this.domainOf(address);
    const rows = await tx.senderPolicy.findMany({
      where: {
        workspaceId,
        OR: [
          { scope: SenderPolicyScope.ADDRESS, pattern: address },
          ...(domain ? [{ scope: SenderPolicyScope.DOMAIN, pattern: domain }] : []),
        ],
      },
    });
    // Exact address match takes precedence over a domain rule.
    const exact = rows.find((r) => r.scope === SenderPolicyScope.ADDRESS);
    if (exact) return exact.kind;
    const dom = rows.find((r) => r.scope === SenderPolicyScope.DOMAIN);
    return dom ? dom.kind : null;
  }

  async list(workspaceId: string, ucUid: string | null): Promise<SenderPolicyView[]> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const rows = await tx.senderPolicy.findMany({
        where: { workspaceId },
        orderBy: [{ kind: 'asc' }, { pattern: 'asc' }],
        take: 1000,
      });
      return rows.map((r) => this.toView(r));
    });
  }

  /** Set (upsert) a rule. Flipping BLOCK↔ALLOW on the same (scope,pattern) updates it. */
  async set(
    workspaceId: string,
    ucUid: string | null,
    input: SetSenderPolicyInput,
  ): Promise<SenderPolicyView> {
    const pattern = this.normalize(input.scope, input.pattern);
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const row = await tx.senderPolicy.upsert({
        where: {
          workspaceId_scope_pattern: { workspaceId, scope: input.scope, pattern },
        },
        create: {
          workspaceId,
          scope: input.scope,
          pattern,
          kind: input.kind,
          reason: input.reason ?? null,
          setByUcUid: ucUid,
          setByAgentKey: input.agentKey ?? null,
        },
        update: {
          kind: input.kind,
          reason: input.reason ?? null,
          setByUcUid: ucUid,
          setByAgentKey: input.agentKey ?? null,
        },
      });
      return this.toView(row);
    });
  }

  /** Remove a rule by id (workspace-scoped). Returns true when a row was deleted. */
  async remove(workspaceId: string, ucUid: string | null, id: string): Promise<boolean> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const res = await tx.senderPolicy.deleteMany({ where: { id, workspaceId } });
      return res.count > 0;
    });
  }

  private toView(r: SenderPolicy): SenderPolicyView {
    return {
      id: r.id,
      scope: r.scope,
      pattern: r.pattern,
      kind: r.kind,
      reason: r.reason,
      set_by_uc_uid: r.setByUcUid,
      set_by_agent_key: r.setByAgentKey,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }
}
