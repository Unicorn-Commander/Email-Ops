import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentInboxKind,
  AgentInboxState,
  CleanupActionKind,
  CleanupBatchState,
  User,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { MembershipService } from '../common/workspace/membership.service';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { PrismaService } from '../prisma/prisma.service';
import { checkCleanerEntitlement } from './entitlement';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import {
  CleanupBatchView,
  CleanupExecutionBackupRef,
  CleanupExecutionResult,
  CleanupMode,
  CleanupPlanMessageView,
  CleanupPlanResult,
  CleanupWriteMode,
  ConnectedAccountsAnalysisResult,
  ConnectedAccountsListResult,
  ConnectedAccountsStatsResult,
  ConnectedProvider,
  EngineBackupManifest,
  EngineInboxStats,
  EngineMessageSummary,
  LinkedAccountView,
} from './connected-accounts.types';

type IdpAlias = 'google' | 'microsoft';

interface CleanupCriteria {
  query?: string;
  categories?: string[];
  sender_groups?: string[];
  senderGroup?: string[];
  label?: string;
  archive?: boolean;
  max_results?: number;
  maxResults?: number;
  [key: string]: unknown;
}

interface CleanupExecutionOptions {
  batchId?: string;
  agentInboxItemId?: string | null;
  requestedByUcUid?: string | null;
}

@Injectable()
export class ConnectedAccountsService {
  private readonly logger = new Logger(ConnectedAccountsService.name);

  constructor(
    private readonly broker: KeycloakBrokerService,
    private readonly membership: MembershipService,
    private readonly engine: ConnectedAccountsEnginePort,
    private readonly prisma: PrismaService,
  ) {}

  async listConnectedAccounts(user: User): Promise<ConnectedAccountsListResult> {
    const providers: ConnectedProvider[] = ['gmail', 'microsoft'];
    const accounts: LinkedAccountView[] = [];
    for (const provider of providers) {
      accounts.push({
        provider,
        linked: (await this.safeBrokerToken(user, provider)) !== null,
      });
    }
    return { accounts };
  }

  async getInboxStats(
    user: User,
    provider: ConnectedProvider,
  ): Promise<ConnectedAccountsStatsResult> {
    const accessToken = await this.safeBrokerToken(user, provider);
    if (!accessToken) {
      return {
        available: false,
        provider,
        reason: `no linked ${provider} account — sign in via ${provider} first`,
      };
    }

    let stats: Awaited<ReturnType<ConnectedAccountsEnginePort['getInboxStats']>> | null = null;
    try {
      stats = await this.engine.getInboxStats(provider, this.credentialsFor(provider, accessToken));
    } catch {
      stats = null;
    }
    if (!stats) {
      return {
        available: false,
        provider,
        reason: 'Cleaner Engine unavailable',
      };
    }

    return { available: true, provider, stats };
  }

  async analyzeInbox(
    user: User,
    provider: ConnectedProvider,
  ): Promise<ConnectedAccountsAnalysisResult> {
    const accessToken = await this.safeBrokerToken(user, provider);
    if (!accessToken) {
      return {
        available: false,
        provider,
        reason: `no linked ${provider} account — sign in via ${provider} first`,
      };
    }

    let analysis: Record<string, unknown> | null = null;
    try {
      analysis = await this.engine.analyzeInbox(provider, this.credentialsFor(provider, accessToken));
    } catch {
      analysis = null;
    }
    if (!analysis) {
      return {
        available: false,
        provider,
        reason: 'Cleaner Engine unavailable',
      };
    }

    return { available: true, provider, analysis };
  }

  async planCleanup(
    user: User,
    provider: ConnectedProvider,
    criteria: CleanupCriteria,
  ): Promise<CleanupPlanResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);

    const accessToken = await this.safeBrokerToken(user, provider);
    if (!accessToken) {
      throw new ForbiddenException(`no linked ${provider} account — sign in via ${provider} first`);
    }

    const fetched = await this.collectMessages(provider, accessToken, criteria);
    const plans = fetched.map((message) => this.classifyMessage(message));
    const protectedRows = plans.filter((row) => row.protected);
    const safeRows = plans.filter((row) => !row.protected);

    return {
      provider,
      criteria: this.normalizeCriteria(criteria),
      counts: {
        reviewed: plans.length,
        safe: safeRows.length,
        protected: protectedRows.length,
      },
      freesBytes: safeRows.reduce((sum, row) => sum + row.size_bytes, 0),
      protected: protectedRows,
      safe: safeRows,
      backup_query: this.backupQueryFor(criteria),
    };
  }

  async executeCleanup(
    user: User,
    provider: ConnectedProvider,
    plan: CleanupPlanResult,
    mode: CleanupMode,
    options: CleanupExecutionOptions = {},
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);

    const accessToken = await this.safeBrokerToken(user, provider);
    if (!accessToken) {
      throw new ForbiddenException(`no linked ${provider} account — sign in via ${provider} first`);
    }

    const serverPlan = await this.planCleanup(user, provider, plan.criteria as CleanupCriteria);
    const safeIds = new Set(serverPlan.safe.map((row) => row.id));
    const requested = (plan.safe.length ? plan.safe : serverPlan.safe)
      .map((row) => row.id)
      .filter((id) => safeIds.has(id));

    if (mode === 'delete') {
      // Gated OFF until archive-and-purge exists: permanent delete (Gmail
      // batchDelete) is irreversible and today's backup is an ephemeral tmp
      // file with no restore path. Re-enabled in Phase 6.1 as export→download→
      // purge. Trash (reversible) is the live cleanup until then.
      throw new ForbiddenException(
        'Permanent purge is temporarily disabled while archive-and-purge is built — nothing was deleted. Use trash (reversible) for now.',
      );
    }

    return this.prisma.withWorkspace(workspaceId, ucUidOf(user as WithWorkspaceClaim), async (tx) => {
      const count = await this.engine.batchTrash(
        provider,
        this.credentialsFor(provider, accessToken),
        requested,
      );
      const result = this.cleanupResult({
        completed: count?.count ?? 0,
        failed: Math.max(0, requested.length - (count?.count ?? 0)),
        bytesFreed: this.estimateBytes(serverPlan.safe, requested),
        totalAttempted: requested.length,
      });
      const batch = await tx.cleanupBatch.create({
        data: {
          workspaceId,
          provider,
          action: CleanupActionKind.TRASH,
          mode,
          state: CleanupBatchState.COMPLETED,
            criteria: serverPlan.criteria as any,
            plan: serverPlan as any,
          result,
          requestedByUcUid: options.requestedByUcUid ?? ucUidOf(user as WithWorkspaceClaim),
          approvedByUcUid: options.requestedByUcUid ?? ucUidOf(user as WithWorkspaceClaim),
          agentInboxItemId: options.agentInboxItemId ?? null,
          summary: this.batchSummary('trash', provider, requested.length, null),
          params: this.batchParams(plan.criteria),
          completedAt: new Date(),
        },
      });
      return {
        ok: true,
        provider,
        mode,
        batch_id: batch.id,
        action: 'trash',
        plan: serverPlan,
        result,
        status: 'completed',
      };
    });
  }

  async organize(
    user: User,
    provider: ConnectedProvider,
    criteria: CleanupCriteria,
  ): Promise<CleanupExecutionResult> {
    const plan = await this.planCleanup(user, provider, criteria);
    return this.unsupportedResult(
      provider,
      'archive',
      plan,
      'Organize/archive is coming with the archive release — no messages were changed.',
    );
  }

  async unsubscribe(
    user: User,
    provider: ConnectedProvider,
    senderGroup: string[],
  ): Promise<CleanupExecutionResult> {
    const criteria: CleanupCriteria = { senderGroup, query: '' };
    const plan = await this.planCleanup(user, provider, criteria);
    return this.unsupportedResult(
      provider,
      'unsubscribe',
      plan,
      'Unsubscribe is coming with the archive release — no messages were changed.',
    );
  }

  async undoBatch(user: User, provider: ConnectedProvider, batchId: string): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);

    const batch = await this.prisma.cleanupBatch.findFirst({
      where: { id: batchId, workspaceId, provider },
    });
    if (!batch) {
      throw new NotFoundException('Cleanup batch not found.');
    }

    // Programmatic restore is not built yet (Phase 6.1). Do NOT flip the batch
    // to UNDONE — that would falsely claim the mailbox was reverted. Return
    // honest, action-specific guidance instead.
    const providerTrash = provider === 'gmail' ? 'Gmail Trash' : 'Outlook Deleted Items';
    const reason =
      batch.action === CleanupActionKind.TRASH
        ? `Trashed messages are in your ${providerTrash} and can be restored there (~30 days). One-click restore arrives with the archive release.`
        : batch.action === CleanupActionKind.DELETE
          ? 'A permanent purge cannot be undone — restore-from-archive arrives with the archive release.'
          : 'Undo is not available for this action yet.';

    return {
      ok: false,
      provider,
      mode: 'undo',
      batch_id: batch.id,
      action: 'undo',
      plan: batch.plan as unknown as CleanupPlanResult,
      result: this.cleanupResult({
        completed: 0,
        failed: 0,
        bytesFreed: 0,
        totalAttempted: 0,
      }),
      status: 'rejected',
      reason,
    };
  }

  async stageCleanupRequest(
    user: User,
    provider: ConnectedProvider,
    mode: CleanupWriteMode,
    action: CleanupActionKind,
    criteria: CleanupCriteria,
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    const accessToken = await this.safeBrokerToken(user, provider);
    if (!accessToken) {
      throw new ForbiddenException(`no linked ${provider} account — sign in via ${provider} first`);
    }

    const plan = await this.planCleanup(user, provider, criteria);

    if (action !== CleanupActionKind.TRASH) {
      // Only trash stages today. delete/organize/unsubscribe are gated until
      // Phase 6.1 — don't create a PENDING approval item that would fail on
      // execution. Return the read-only plan + an honest reason instead.
      const reason =
        action === CleanupActionKind.DELETE
          ? 'Permanent purge is temporarily disabled while archive-and-purge is built — nothing was staged. Use trash (reversible) for now.'
          : `${action.charAt(0)}${action.slice(1).toLowerCase()} is coming with the archive release — nothing was staged.`;
      return this.unsupportedResult(provider, mode, plan, reason);
    }

    const requestedByUcUid = ucUidOf(user as WithWorkspaceClaim);
    return this.prisma.withWorkspace(workspaceId, requestedByUcUid, async (tx) => {
      const batch = await tx.cleanupBatch.create({
        data: {
          workspaceId,
          provider,
          action,
          mode,
          state: CleanupBatchState.PENDING,
          criteria: plan.criteria as any,
          plan: plan as any,
          requestedByUcUid,
          summary: this.batchSummary(mode, provider, plan.safe.length, null),
          params: this.batchParams(criteria),
        },
      });

      const item = await tx.agentInboxItem.create({
        data: {
          workspaceId,
          messageId: null,
          kind: AgentInboxKind.CLEANUP,
          payload: {
            batch_id: batch.id,
            provider,
            action,
            mode,
            criteria: plan.criteria as any,
            plan: plan as any,
          },
          state: AgentInboxState.PENDING,
          draftedBy: 'email-ops-agent',
          summary: this.batchSummary(mode, provider, plan.safe.length, null),
        },
      });

      await tx.cleanupBatch.update({
        where: { id: batch.id },
        data: { agentInboxItemId: item.id },
      });

      return {
        ok: true,
        provider,
        mode,
        batch_id: batch.id,
        action,
        plan,
        result: this.cleanupResult({
          completed: 0,
          failed: 0,
          bytesFreed: 0,
          totalAttempted: plan.safe.length,
        }),
        status: 'pending',
        staged: true,
        staged_item_id: item.id,
        reason: 'staged into agent inbox for human approval',
      };
    });
  }

  async approveCleanupBatch(
    workspaceId: string,
    user: User,
    batchId: string,
  ): Promise<CleanupExecutionResult | null> {
    const batch = await this.prisma.cleanupBatch.findFirst({
      where: { id: batchId, workspaceId },
    });
    if (!batch) return null;
    if (batch.state !== CleanupBatchState.PENDING) {
      return this.cleanupResultFromBatch(batch);
    }

    const plan = batch.plan as unknown as CleanupPlanResult;
    const accessToken = await this.safeBrokerToken(user, batch.provider as ConnectedProvider);
    if (!accessToken) {
      throw new ForbiddenException(
        `no linked ${batch.provider} account — sign in via ${batch.provider} first`,
      );
    }
    let result: CleanupExecutionResult;
    try {
      result = await this.executeCleanupInternal(
        workspaceId,
        ucUidOf(user as WithWorkspaceClaim),
        batch.provider as ConnectedProvider,
        plan,
        batch.mode as CleanupWriteMode,
        accessToken,
        {
          batchId: batch.id,
          agentInboxItemId: batch.agentInboxItemId,
          requestedByUcUid: ucUidOf(user as WithWorkspaceClaim),
        },
      );
    } catch (err) {
      // A disabled (delete) or not-yet-implemented (archive/unsubscribe) mode
      // throws here. Record the batch as FAILED with the reason — never leave
      // it PENDING and never fall through to a destructive default.
      const reason = err instanceof Error ? err.message : 'cleanup could not be executed';
      await this.prisma.cleanupBatch.update({
        where: { id: batch.id },
        data: {
          state: CleanupBatchState.FAILED,
          approvedByUcUid: ucUidOf(user as WithWorkspaceClaim),
          result: { completed: 0, failed: 0, bytes_freed: 0, total_attempted: 0, reason } as any,
        },
      });
      return {
        ok: false,
        provider: batch.provider as ConnectedProvider,
        mode: batch.mode as CleanupWriteMode,
        batch_id: batch.id,
        action: batch.action.toLowerCase(),
        plan,
        result: this.cleanupResult({ completed: 0, failed: 0, bytesFreed: 0, totalAttempted: 0 }),
        status: 'failed',
        reason,
      };
    }
    await this.prisma.cleanupBatch.update({
      where: { id: batch.id },
      data: {
        state: CleanupBatchState.COMPLETED,
        completedAt: new Date(),
        approvedByUcUid: ucUidOf(user as WithWorkspaceClaim),
        result: result.result as any,
      },
    });
    return result;
  }

  async listCleanupActivity(user: User, provider: ConnectedProvider): Promise<CleanupBatchView[]> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    const rows = await this.prisma.cleanupBatch.findMany({
      where: { workspaceId, provider },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });
    return rows.map((row) => this.batchView(row));
  }

  private async executeCleanupInternal(
    workspaceId: string,
    ucUid: string,
    provider: ConnectedProvider,
    plan: CleanupPlanResult,
    mode: CleanupWriteMode,
    accessToken: string,
    options: CleanupExecutionOptions = {},
  ): Promise<CleanupExecutionResult> {
    if (mode === 'delete') {
      // See executeCleanup: permanent purge is gated OFF until Phase 6.1
      // archive-and-purge. Approving a staged DELETE fails loudly (caught by
      // approveCleanupBatch → batch FAILED) rather than purging irreversibly.
      throw new ForbiddenException(
        'Permanent purge is temporarily disabled while archive-and-purge is built — nothing was deleted. Use trash (reversible) for now.',
      );
    }
    if (mode !== 'trash') {
      // archive / organize / unsubscribe land in Phase 6.1. Until then they
      // must NOT silently fall through to trash (the original bug).
      throw new BadRequestException(
        `"${mode}" cleanup is not implemented yet (coming with the archive release) — no messages were changed.`,
      );
    }

    const serverPlan = plan;
    const safeIds = new Set(serverPlan.safe.map((row) => row.id));
    const requested = (plan.safe.length ? plan.safe : serverPlan.safe)
      .map((row) => row.id)
      .filter((id) => safeIds.has(id));

    const count = await this.engine.batchTrash(
      provider,
      this.credentialsFor(provider, accessToken),
      requested,
    );
    const result = this.cleanupResult({
      completed: count?.count ?? 0,
      failed: Math.max(0, requested.length - (count?.count ?? 0)),
      bytesFreed: this.estimateBytes(serverPlan.safe, requested),
      totalAttempted: requested.length,
    });
    return {
      ok: true,
      provider,
      mode,
      batch_id: options.batchId ?? randomUUID(),
      action: 'trash',
      plan: serverPlan,
      result,
      status: 'completed',
    };
  }

  /**
   * Honest result for actions that are planned but not yet executable (archive /
   * organize / unsubscribe land in Phase 6.1). Returns the read-only plan so the
   * UI can preview what WOULD be affected, but does NOT persist a COMPLETED batch
   * and does NOT touch the mailbox.
   */
  private unsupportedResult(
    provider: ConnectedProvider,
    mode: CleanupWriteMode,
    plan: CleanupPlanResult,
    reason: string,
  ): CleanupExecutionResult {
    return {
      ok: false,
      provider,
      mode,
      batch_id: '',
      action: mode,
      plan,
      result: this.cleanupResult({
        completed: 0,
        failed: 0,
        bytesFreed: 0,
        totalAttempted: plan.safe.length,
      }),
      status: 'rejected',
      reason,
    };
  }

  private cleanupResult(input: {
    completed: number;
    failed: number;
    bytesFreed: number;
    totalAttempted: number;
  }) {
    return {
      completed: input.completed,
      failed: input.failed,
      bytes_freed: input.bytesFreed,
      total_attempted: input.totalAttempted,
    };
  }

  private cleanupResultFromBatch(batch: {
    id: string;
    provider: string;
    mode: string;
    action: CleanupActionKind;
    plan: unknown;
    result: unknown;
    backupRef: string | null;
    backupVerified: boolean;
  }): CleanupExecutionResult {
    return {
      ok: true,
      provider: batch.provider as ConnectedProvider,
      mode: batch.mode as CleanupWriteMode,
      batch_id: batch.id,
      action: batch.action.toLowerCase(),
      plan: batch.plan as unknown as CleanupPlanResult,
      result: (batch.result as CleanupExecutionResult['result']) ?? this.cleanupResult({
        completed: 0,
        failed: 0,
        bytesFreed: 0,
        totalAttempted: 0,
      }),
      backup_ref: batch.backupRef
        ? {
            path: batch.backupRef,
            verified: batch.backupVerified,
            created_at: null,
            total_messages: 0,
          }
        : undefined,
      status: 'completed',
    };
  }

  private batchView(row: {
    id: string;
    provider: string;
    action: CleanupActionKind;
    mode: string;
    state: CleanupBatchState;
    summary: string | null;
    params: string | null;
    result: unknown;
    backupRef: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): CleanupBatchView {
    return {
      id: row.id,
      provider: row.provider as ConnectedProvider,
      action: row.action.toLowerCase(),
      mode: row.mode as CleanupMode | 'archive' | 'unsubscribe' | 'undo',
      state: row.state.toLowerCase(),
      summary: row.summary ?? '',
      params: row.params ?? '',
      result: JSON.stringify(row.result ?? {}),
      backup_ref: row.backupRef,
      // Programmatic restore lands in Phase 6.1; until then "undo" is non-functional
      // (trashed mail is recoverable directly in the provider Trash), so don't offer it.
      undoable: false,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private async createVerifiedBackup(
    provider: ConnectedProvider,
    accessToken: string,
    query: string,
  ): Promise<CleanupExecutionBackupRef> {
    const base = path.join(os.tmpdir(), 'email-ops-cleaner');
    const backupPath = path.join(base, provider, `${Date.now()}-${randomUUID()}`);
    const manifest = await this.engine.backupCreate(provider, this.credentialsFor(provider, accessToken), query, backupPath);
    if (!manifest) {
      throw new ForbiddenException('Cleaner Engine unavailable while creating backup.');
    }
    const verification = await this.engine.backupVerify(manifest.path);
    const verified = Boolean(verification && (verification as Record<string, unknown>).success);
    return {
      path: manifest.path,
      verified,
      created_at: manifest.created_at,
      total_messages: manifest.total_messages,
    };
  }

  private async collectMessages(
    provider: ConnectedProvider,
    accessToken: string,
    criteria: CleanupCriteria,
  ): Promise<EngineMessageSummary[]> {
    const credentials = this.credentialsFor(provider, accessToken);
    const query = this.backupQueryFor(criteria);
    const limit = Math.max(1, Math.min(Number(criteria.max_results ?? criteria.maxResults ?? 200), 500));
    const messages: EngineMessageSummary[] = [];
    let pageToken: string | null | undefined = null;

    for (let page = 0; page < 10; page += 1) {
      const res = await this.engine.listMessages(provider, credentials, query, limit, pageToken ?? null);
      if (!res) break;
      const pageMessages = Array.isArray(res.messages) ? res.messages : [];
      messages.push(...pageMessages);
      pageToken = res.next_token ?? null;
      if (!pageToken) break;
    }

    const enriched: EngineMessageSummary[] = [];
    for (const message of messages) {
      if (this.needsEnrichment(message)) {
        const full = await this.engine.getMessage(provider, credentials, message.id, 'metadata');
        enriched.push(full ?? message);
      } else {
        enriched.push(message);
      }
    }
    return enriched;
  }

  private needsEnrichment(message: EngineMessageSummary): boolean {
    return (
      !message.sender ||
      message.size_bytes === undefined ||
      message.is_starred === undefined ||
      !message.labels
    );
  }

  private classifyMessage(message: EngineMessageSummary): CleanupPlanMessageView {
    const sender = this.senderOf(message.sender ?? null);
    const size = Number(message.size_bytes ?? 0);
    const labels = Array.isArray(message.labels) ? message.labels : [];
    const starred = Boolean(message.is_starred);
    const reason = this.protectionReason(message.sender ?? null, starred);
    return {
      id: message.id,
      sender,
      subject: this.cleanString(message.subject ?? null),
      date: this.cleanString(message.date ?? null),
      size_bytes: Number.isFinite(size) ? size : 0,
      starred,
      labels,
      protected: reason !== null,
      reason,
    };
  }

  private protectionReason(sender: string | null, starred: boolean): string | null {
    if (starred) return 'starred';
    const domain = this.extractDomain(sender);
    if (!domain) return 'unparseable sender';
    const domains = this.protectedDomains();
    if (domains.includes(domain)) return `protected domain: ${domain}`;
    for (const suffix of this.protectedSuffixes()) {
      if (domain.endsWith(suffix)) return `protected suffix: ${suffix}`;
    }
    return null;
  }

  private protectedDomains(): string[] {
    return this.parseCsvEnv('EMAIL_CLEANER_PROTECTED_DOMAINS', [
      'usaa.com',
      'bankofamerica.com',
      'chase.com',
      'paypal.com',
      'venmo.com',
      'mychart.com',
      'questdiagnostics.com',
    ]);
  }

  private protectedSuffixes(): string[] {
    return this.parseCsvEnv('EMAIL_CLEANER_PROTECTED_SUFFIXES', ['.gov', '.mil', '.edu']);
  }

  private parseCsvEnv(name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    if (!raw) return fallback;
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private normalizeCriteria(criteria: CleanupCriteria): Record<string, unknown> {
    return {
      ...criteria,
      query: typeof criteria.query === 'string' ? criteria.query : '',
      categories: Array.isArray(criteria.categories) ? criteria.categories : [],
      senderGroup: Array.isArray(criteria.senderGroup)
        ? criteria.senderGroup
        : Array.isArray(criteria.sender_groups)
          ? criteria.sender_groups
          : [],
    };
  }

  private backupQueryFor(criteria: CleanupCriteria): string {
    return typeof criteria.query === 'string' ? criteria.query : '';
  }

  private batchSummary(mode: string, provider: ConnectedProvider, count: number, backupRef: string | null): string {
    const suffix = backupRef ? ` backup=${backupRef}` : '';
    return `${mode} ${count} messages on ${provider}${suffix}`;
  }

  private batchParams(criteria: CleanupCriteria): string {
    const params = this.normalizeCriteria(criteria);
    return JSON.stringify(params);
  }

  private estimateBytes(safe: CleanupPlanMessageView[], requestedIds: string[]): number {
    const byId = new Map(safe.map((row) => [row.id, row.size_bytes]));
    return requestedIds.reduce((sum, id) => sum + (byId.get(id) ?? 0), 0);
  }

  private cleanString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private senderOf(sender: string | null): string | null {
    return this.cleanString(sender);
  }

  private extractDomain(sender: string | null): string {
    if (!sender) return '';
    const match = sender.match(/<([^>]+)>/);
    const address = match?.[1] ?? sender;
    const at = address.lastIndexOf('@');
    if (at < 0) return '';
    return address.slice(at + 1).trim().toLowerCase();
  }

  private async resolveWorkspace(user: User): Promise<string> {
    return this.membership.resolveAndAuthorize(user, null);
  }

  private requireCleanerEntitlement(user: User, workspaceId: string): void {
    const gate = checkCleanerEntitlement(this.entitlementsOf(user), workspaceId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason);
    }
  }

  private entitlementsOf(user: User): string[] {
    return Array.isArray((user as WithWorkspaceClaim).__entitlements)
      ? ((user as WithWorkspaceClaim).__entitlements as string[])
      : [];
  }

  private aliasFor(provider: ConnectedProvider): IdpAlias {
    return provider === 'gmail' ? 'google' : 'microsoft';
  }

  private async safeBrokerToken(user: User, provider: ConnectedProvider): Promise<string | null> {
    try {
      return await this.broker.getProviderAccessToken(user, this.aliasFor(provider));
    } catch {
      return null;
    }
  }

  private credentialsFor(provider: ConnectedProvider, accessToken: string): Record<string, unknown> {
    return provider === 'gmail'
      ? { token: accessToken }
      : { access_token: accessToken };
  }
}
