import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AgentInboxKind,
  AgentInboxState,
  CleanupActionKind,
  CleanupBatchState,
  User,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { KeycloakBrokerService } from '../auth/keycloak-broker.service';
import { MembershipService } from '../common/workspace/membership.service';
import { ucUidOf, WithWorkspaceClaim } from '../common/workspace/workspace.util';
import { PrismaService } from '../prisma/prisma.service';
import { checkCleanerEntitlement, checkVaultEntitlement } from './entitlement';
import { cleanupTargetsFromPlan } from './cleanup-targets';
import { ArchiveStorageService } from './archive-storage.service';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import { StableNotifierService } from '../notify/stable-notifier.service';
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
  /** Explicit message ids selected in the UI (organize / execute). */
  messageIds?: string[];
  message_ids?: string[];
  [key: string]: unknown;
}

interface CleanupExecutionOptions {
  batchId?: string;
  agentInboxItemId?: string | null;
  requestedByUcUid?: string | null;
  archiveRetained?: boolean;
  /**
   * When true, run the destructive batch immediately (used by the approval path
   * and by an explicit REST confirm). Default / REST is to STAGE for human approval.
   */
  confirm?: boolean;
  /** Typed confirmation for permanent delete (`ARCHIVE`). */
  confirmToken?: string | null;
}

/**
 * How many messages one interactive (on-demand) cleanup plan reviews. The plan
 * is a bounded preview the user acts on, then re-runs — capping it keeps a run
 * to seconds and the response small. A comprehensive sweep is the scheduled
 * path, not this one.
 */
const REVIEW_PREVIEW_CAP = 500;

/** Concurrent metadata fetches while building a plan (serial was the ~4min hang). */
const ENRICH_CONCURRENCY = 8;

/**
 * Cleanup category → provider search term (Gmail syntax). Used to SCOPE the fetch
 * so a plan only pulls the selected categories, never the whole mailbox.
 */
const CATEGORY_QUERY: Record<string, string> = {
  promotional: 'category:promotions',
  promotions: 'category:promotions',
  social: 'category:social',
  newsletter: 'category:updates',
  updates: 'category:updates',
  forums: 'category:forums',
};

/**
 * Cleanup category → the message labels that prove membership. The classifier
 * uses this as a SAFETY GATE: a message is only ever "safe to delete" when it
 * actually carries one of the selected categories' labels (or the user gave an
 * explicit free-text query). Without it, personal/Sent mail was marked safe.
 */
const CATEGORY_LABELS: Record<string, string[]> = {
  promotional: ['CATEGORY_PROMOTIONS'],
  promotions: ['CATEGORY_PROMOTIONS'],
  social: ['CATEGORY_SOCIAL'],
  newsletter: ['CATEGORY_UPDATES', 'CATEGORY_FORUMS'],
  updates: ['CATEGORY_UPDATES'],
  forums: ['CATEGORY_FORUMS'],
};

const CLEANUP_AGENT_KEY = 'email-ops-agent';

@Injectable()
export class ConnectedAccountsService {
  private readonly logger = new Logger(ConnectedAccountsService.name);

  constructor(
    private readonly broker: KeycloakBrokerService,
    private readonly membership: MembershipService,
    private readonly engine: ConnectedAccountsEnginePort,
    private readonly prisma: PrismaService,
    private readonly archiveStorage: ArchiveStorageService,
    // Wave 9: the Stable approval-notification seam. Optional (last) so the
    // positional-construction unit specs stay valid; guarded on every use.
    private readonly notifier?: StableNotifierService,
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

  /**
   * Mint an in-app Keycloak account-link URL so the user can connect a provider
   * (gmail->google / microsoft) to their existing uchub identity. The return URL
   * is derived server-side from FRONTEND_URL (no user-supplied redirect, so no
   * open-redirect surface). Available to any authenticated user — linking
   * necessarily precedes having a usable mailbox, so it is NOT entitlement-gated.
   */
  async getProviderLinkUrl(user: User, provider: ConnectedProvider): Promise<{ url: string }> {
    const base = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
    const redirectUri = `${base}/accounts?linked=${provider}`;
    const url = await this.broker.buildAccountLinkUrl(user, this.aliasFor(provider), redirectUri);
    if (!url) {
      throw new ForbiddenException(
        'Could not start account linking — your SSO session may have expired. Sign out and back in, then try again.',
      );
    }
    return { url };
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
      analysis = await this.engine.analyzeInbox(
        provider,
        this.credentialsFor(provider, accessToken),
      );
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
    const queryText = typeof criteria.query === 'string' ? criteria.query.trim() : '';
    const categories = Array.isArray(criteria.categories)
      ? criteria.categories.map((c) => String(c).toLowerCase())
      : [];
    const plans = fetched.map((message) => this.classifyMessage(message));
    const protectedRows = plans.filter((row) => row.protected);
    // SAFETY: a message is "safe to delete" only when the user actually targeted
    // it (category label match or a query the row VISIBLY matches) — never just
    // "not protected", which had swept in personal and Sent mail.
    const safeRows = plans.filter(
      (row, i) => !row.protected && this.isCleanupCandidate(row, fetched[i], categories, queryText),
    );

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

    // REST parity with MCP/chat: destructive batches STAGE for human approval by
    // default. Immediate execution requires an explicit confirm flag (and for
    // permanent delete, a typed ARCHIVE token). The approval path passes
    // confirm:true via executeCleanupInternal, not this public entrypoint.
    if (!options.confirm) {
      const action =
        mode === 'trash'
          ? CleanupActionKind.TRASH
          : mode === 'delete' || mode === 'archive_purge'
            ? CleanupActionKind.DELETE
            : CleanupActionKind.TRASH;
      // Re-plan from criteria for a fresh protection gate, then INTERSECT with
      // the client's explicit selection so the staged batch (and later approve)
      // only touch what the human picked — never re-expand to the full plan.
      const serverPlan = await this.planCleanup(user, provider, plan.criteria as CleanupCriteria);
      const safeIds = new Set(serverPlan.safe.map((row) => row.id));
      const selected = (Array.isArray(plan.safe) ? plan.safe : [])
        .map((row) => row.id)
        .filter((id) => safeIds.has(id));
      const selectedSafe = serverPlan.safe.filter((row) => selected.includes(row.id));
      const stagedPlan: CleanupPlanResult = {
        ...serverPlan,
        safe: selectedSafe,
        counts: {
          ...serverPlan.counts,
          safe: selectedSafe.length,
        },
        freesBytes: selectedSafe.reduce((sum, row) => sum + row.size_bytes, 0),
      };
      return this.stageCleanupRequestWithPlan(user, provider, mode, action, stagedPlan);
    }

    if (
      (mode === 'delete' || mode === 'archive_purge') &&
      (options.confirmToken ?? '').trim() !== 'ARCHIVE'
    ) {
      throw new BadRequestException(
        'Permanent delete requires typed confirmation: set confirm_token to "ARCHIVE".',
      );
    }

    const serverPlan = await this.planCleanup(user, provider, plan.criteria as CleanupCriteria);
    const safeIds = new Set(serverPlan.safe.map((row) => row.id));
    // Only the ids the client EXPLICITLY selected, intersected with what the fresh
    // server plan still considers safe. An empty selection means "nothing" — it must
    // NEVER fall back to trashing/deleting the entire server-planned set.
    const requested = (Array.isArray(plan.safe) ? plan.safe : [])
      .map((row) => row.id)
      .filter((id) => safeIds.has(id));

    return this.prisma.withWorkspace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      async (tx) => {
        const batchId = options.batchId ?? randomUUID();
        const credentials = this.credentialsFor(provider, accessToken);
        const vault = this.hasVaultEntitlement(user, workspaceId);
        const archiveExpiresAt = vault ? null : this.daysFromNow(7);
        let archiveRef: CleanupExecutionBackupRef | null = null;
        let action: CleanupActionKind = CleanupActionKind.TRASH;
        let completedCount = 0;

        if (mode === 'delete' || mode === 'archive_purge') {
          action = CleanupActionKind.DELETE;
          archiveRef = await this.createVerifiedGarageArchive({
            workspaceId,
            provider,
            credentials,
            messageIds: requested,
            batchId,
            query: serverPlan.backup_query,
            archiveExpiresAt,
            archiveRetained: vault,
          });
          const count = this.assertEngineApplied(
            await this.engine.batchDelete(provider, credentials, requested),
            'delete',
          );
          completedCount = count.count;
        } else if (mode === 'trash') {
          const count = this.assertEngineApplied(
            await this.engine.batchTrash(provider, credentials, requested),
            'trash',
          );
          completedCount = count.count;
        } else {
          throw new BadRequestException(
            `"${mode}" cleanup is not implemented for direct execution.`,
          );
        }

        // NOTE: The engine returns a single count for batch operations, not per-ID failures.
        // Therefore, "failed" is an estimate: requested - completed. This is the best available
        // metric for partial successes (e.g. some IDs already gone).
        const result = this.cleanupResult({
          completed: completedCount,
          failed: Math.max(0, requested.length - completedCount),
          bytesFreed: this.estimateBytes(serverPlan.safe, requested),
          totalAttempted: requested.length,
        });
        const batch = await tx.cleanupBatch.create({
          data: {
            id: batchId,
            workspaceId,
            provider,
            action,
            mode,
            state: CleanupBatchState.COMPLETED,
            criteria: serverPlan.criteria as any,
            plan: serverPlan as any,
            result,
            backupRef: archiveRef?.key ?? null,
            backupVerified: archiveRef?.verified ?? false,
            archiveBucket: archiveRef?.bucket ?? null,
            archiveKey: archiveRef?.key ?? null,
            archiveBytes: archiveRef?.bytes ? BigInt(archiveRef.bytes) : null,
            archiveSha256: archiveRef?.sha256 ?? null,
            archiveExpiresAt,
            archiveRetained: vault,
            requestedByUcUid: options.requestedByUcUid ?? ucUidOf(user as WithWorkspaceClaim),
            approvedByUcUid: options.requestedByUcUid ?? ucUidOf(user as WithWorkspaceClaim),
            agentInboxItemId: options.agentInboxItemId ?? null,
            summary: this.batchSummary(
              action.toLowerCase(),
              provider,
              requested.length,
              archiveRef?.key ?? null,
            ),
            params: this.batchParams(plan.criteria),
            completedAt: new Date(),
          },
        });
        if (options.agentInboxItemId) {
          await tx.agentInboxItem.update({
            where: { id: options.agentInboxItemId },
            data: {
              state: AgentInboxState.APPROVED,
              reviewedByUcUid: options.requestedByUcUid ?? ucUidOf(user as WithWorkspaceClaim),
              reviewedAt: new Date(),
            },
          });
        }
        return {
          ok: true,
          provider,
          mode,
          batch_id: batch.id,
          action: action.toLowerCase(),
          plan: serverPlan,
          result,
          backup_ref: archiveRef,
          status: 'completed',
        };
      },
    );
  }

  async organize(
    user: User,
    provider: ConnectedProvider,
    criteria: CleanupCriteria,
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    const accessToken = await this.requireAccessToken(user, provider);
    const plan = await this.planCleanup(user, provider, criteria);
    // Honour explicit message selection from the UI. An empty selection is a
    // no-op (never fall back to archiving the entire plan). When no selection
    // key is present at all, keep the legacy "all safe rows" behaviour so MCP
    // criteria-only organize still works.
    const requested = this.selectedSafeIds(plan, criteria);
    const count = this.assertEngineApplied(
      await this.engine.batchArchive(
        provider,
        this.credentialsFor(provider, accessToken),
        requested,
        typeof plan.criteria.label === 'string' ? plan.criteria.label : null,
      ),
      'organize',
    );
    // NOTE: The engine returns a single count for batch operations, not per-ID failures.
    // Therefore, "failed" is an estimate: requested - completed. This is the best available
    // metric for partial successes (e.g. some IDs already gone).
    const result = this.cleanupResult({
      completed: count.count,
      failed: Math.max(0, requested.length - count.count),
      bytesFreed: 0,
      totalAttempted: requested.length,
    });
    return this.prisma.withWorkspace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      async (tx) => {
        const batch = await tx.cleanupBatch.create({
          data: {
            workspaceId,
            provider,
            action: CleanupActionKind.ORGANIZE,
            mode: 'archive',
            state: CleanupBatchState.COMPLETED,
            criteria: plan.criteria as any,
            plan: plan as any,
            result,
            requestedByUcUid: ucUidOf(user as WithWorkspaceClaim),
            approvedByUcUid: ucUidOf(user as WithWorkspaceClaim),
            summary: this.batchSummary('organize', provider, requested.length, null),
            params: this.batchParams(criteria),
            completedAt: new Date(),
          },
        });
        return {
          ok: true,
          provider,
          mode: 'archive',
          batch_id: batch.id,
          action: 'organize',
          plan,
          result,
          status: 'completed',
        };
      },
    );
  }

  async unsubscribe(
    user: User,
    provider: ConnectedProvider,
    senderGroup: string[],
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    await this.assertAgentWriteAllowed(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      CLEANUP_AGENT_KEY,
    );
    // Still require a linked account up front, so an unlinked caller fails fast
    // instead of staging a batch that could never run on approve.
    await this.requireAccessToken(user, provider);
    const senders = (Array.isArray(senderGroup) ? senderGroup : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!senders.length) {
      throw new BadRequestException('senderGroup must include at least one sender.');
    }

    // Prefer a plan scoped to the senders so the audit batch has a truthful preview.
    const fromQuery = senders.map((s) => `from:${s}`).join(' OR ');
    const criteria: CleanupCriteria = { senderGroup: senders, query: fromQuery };
    const plan = await this.planCleanup(user, provider, criteria);

    // STAGE, never fire. Unsubscribing is irreversible and OUTWARD-FACING: the
    // one-click branch POSTs to a third-party endpoint, and the mailto branch
    // SENDS MAIL FROM THE USER'S OWN ACCOUNT to a third party. It therefore
    // takes the same human-approval gate as every other destructive verb --
    // matching the MCP path (mcp.tools.ts unsubscribeSender) and this file's
    // own contract note on stageCleanupRequestWithPlan. On approve,
    // executeCleanupInternal's `mode === 'unsubscribe'` branch runs the engine
    // and records the real per-sender outcome.
    return this.stageCleanupRequestWithPlan(
      user,
      provider,
      'unsubscribe',
      CleanupActionKind.UNSUBSCRIBE,
      plan,
    );
  }

  async undoBatch(
    user: User,
    provider: ConnectedProvider,
    batchId: string,
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);

    const batch = await this.prisma.withWorkspace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      (tx) =>
        tx.cleanupBatch.findFirst({
          where: { id: batchId, workspaceId, provider },
        }),
    );
    if (!batch) {
      throw new NotFoundException('Cleanup batch not found.');
    }

    if (this.archiveLive(batch)) {
      const accessToken = await this.requireAccessToken(user, provider);
      const restored = await this.engine.archiveRestore(
        provider,
        this.credentialsFor(provider, accessToken),
        batch.archiveBucket!,
        batch.archiveKey!,
      );
      if (!restored) {
        throw new ForbiddenException('Cleaner Engine unavailable while restoring archive.');
      }
      const restoreFailed = Array.isArray(restored.failed)
        ? restored.failed.length
        : Number(restored.failed ?? 0);
      if (restoreFailed > 0) {
        // A reachable engine that re-imported only SOME (or none) of the archive must
        // NOT flip the batch to UNDONE: that sets restoredAt, which retires the still-
        // live archive (archiveLive() => false) and strands whatever failed. Leave the
        // archive live for a retry and report the partial outcome honestly.
        this.logger.warn(
          `undo batch ${batch.id}: restore incomplete (${restored.restored} ok, ${restoreFailed} failed) — archive kept live for retry`,
        );
        return {
          ok: false,
          provider,
          mode: 'undo',
          batch_id: batch.id,
          action: 'undo',
          plan: batch.plan as unknown as CleanupPlanResult,
          result: this.cleanupResult({
            completed: restored.restored,
            failed: restoreFailed,
            bytesFreed: 0,
            totalAttempted: restored.restored + restoreFailed,
          }),
          status: 'failed',
          reason:
            `Restore incomplete: ${restored.restored} message(s) came back, ${restoreFailed} could not be ` +
            `re-imported. The archive is still available — try again, or download it to re-import manually.`,
        };
      }
      await this.prisma.withWorkspace(
        workspaceId,
        ucUidOf(user as WithWorkspaceClaim),
        async (tx) => {
          await tx.cleanupBatch.update({
            where: { id: batch.id },
            data: {
              state: CleanupBatchState.UNDONE,
              restoredAt: new Date(),
              undoneAt: new Date(),
            },
          });
        },
      );
      return {
        ok: true,
        provider,
        mode: 'undo',
        batch_id: batch.id,
        action: 'undo',
        plan: batch.plan as unknown as CleanupPlanResult,
        result: this.cleanupResult({
          completed: restored.restored,
          failed: Array.isArray(restored.failed)
            ? restored.failed.length
            : Number(restored.failed ?? 0),
          bytesFreed: 0,
          totalAttempted:
            restored.restored +
            (Array.isArray(restored.failed)
              ? restored.failed.length
              : Number(restored.failed ?? 0)),
        }),
        status: 'undone',
      };
    }

    const providerTrash = provider === 'gmail' ? 'Gmail Trash' : 'Outlook Deleted Items';
    const reason =
      batch.action === CleanupActionKind.TRASH
        ? `Trashed messages are in your ${providerTrash} and can be restored there (~30 days). One-click restore arrives with the archive release.`
        : batch.action === CleanupActionKind.DELETE
          ? 'This archive is no longer live in the cloud. Use your downloaded archive to re-import manually.'
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
    const requestedByUcUid = ucUidOf(user as WithWorkspaceClaim);
    await this.assertAgentWriteAllowed(workspaceId, requestedByUcUid, CLEANUP_AGENT_KEY);
    const accessToken = await this.safeBrokerToken(user, provider);
    if (!accessToken) {
      throw new ForbiddenException(`no linked ${provider} account — sign in via ${provider} first`);
    }

    const plan = await this.planCleanup(user, provider, criteria);
    // When the caller passed an explicit selection, narrow the staged plan so
    // approval cannot re-expand to the full safe set.
    const narrowed = this.narrowPlanToSelection(plan, criteria);
    return this.stageCleanupRequestWithPlan(user, provider, mode, action, narrowed);
  }

  /**
   * Stage a pre-built plan (already selection-narrowed when needed). Shared by
   * MCP criteria staging and REST execute-without-confirm.
   */
  private async stageCleanupRequestWithPlan(
    user: User,
    provider: ConnectedProvider,
    mode: CleanupWriteMode,
    action: CleanupActionKind,
    plan: CleanupPlanResult,
  ): Promise<CleanupExecutionResult> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    const requestedByUcUid = ucUidOf(user as WithWorkspaceClaim);

    // UNSUBSCRIBE is staged like every other agent destructive verb. On approve,
    // executeCleanupInternal runs the real engine unsubscribe against the
    // sender group in the staged criteria.

    const summary = this.batchSummary(mode, provider, plan.safe.length, null);
    const criteria = plan.criteria as CleanupCriteria;
    const staged = await this.prisma.withWorkspace(workspaceId, requestedByUcUid, async (tx) => {
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
          summary,
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
            // A compact, bounded "what would this touch" preview so the approval
            // surfaces (ReviewCard / in-chat card / MCP) can show the concrete
            // targets — top senders + counts — not just the one-line summary.
            targets: cleanupTargetsFromPlan(action, provider, plan) as any,
          },
          state: AgentInboxState.PENDING,
          draftedBy: 'email-ops-agent',
          summary,
        },
      });

      await tx.cleanupBatch.update({
        where: { id: batch.id },
        data: { agentInboxItemId: item.id },
      });

      return { batchId: batch.id, itemId: item.id };
    });

    // Wave 9: the agent staged a destructive cleanup — notify Stable AFTER the tx
    // commits so a human sees it in the queue. Fire-and-forget/degrade-clean: the
    // notifier never throws, and this must never affect the staged batch.
    if (this.notifier) {
      void this.notifier
        .notifyApprovalPending({
          id: staged.itemId,
          workspaceId,
          kind: AgentInboxKind.CLEANUP,
          summary,
          draftedBy: 'email-ops-agent',
        })
        .catch((err) =>
          this.logger.warn(
            `approval notify failed for cleanup item ${staged.itemId}: ${(err as Error).message}`,
          ),
        );
    }

    return {
      ok: true,
      provider,
      mode,
      batch_id: staged.batchId,
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
      staged_item_id: staged.itemId,
      reason: 'staged into agent inbox for human approval',
    };
  }

  private narrowPlanToSelection(
    plan: CleanupPlanResult,
    criteria: CleanupCriteria,
  ): CleanupPlanResult {
    const raw = Array.isArray(criteria.messageIds)
      ? criteria.messageIds
      : Array.isArray(criteria.message_ids)
        ? criteria.message_ids
        : null;
    if (raw === null) return plan;
    const wanted = new Set(raw.map(String));
    const safe = plan.safe.filter((row) => wanted.has(row.id));
    return {
      ...plan,
      safe,
      counts: { ...plan.counts, safe: safe.length },
      freesBytes: safe.reduce((sum, row) => sum + row.size_bytes, 0),
    };
  }

  async approveCleanupBatch(
    workspaceId: string,
    user: User,
    batchId: string,
  ): Promise<CleanupExecutionResult | null> {
    const batch = await this.prisma.withWorkspace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      (tx) =>
        tx.cleanupBatch.findFirst({
          where: { id: batchId, workspaceId },
        }),
    );
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
          archiveRetained: this.hasVaultEntitlement(user, workspaceId),
        },
      );
    } catch (err) {
      // A disabled (delete) or not-yet-implemented (archive/unsubscribe) mode
      // throws here. Record the batch as FAILED with the reason — never leave
      // it PENDING and never fall through to a destructive default.
      const reason = err instanceof Error ? err.message : 'cleanup could not be executed';
      await this.prisma.withWorkspace(
        workspaceId,
        ucUidOf(user as WithWorkspaceClaim),
        async (tx) => {
          await tx.cleanupBatch.update({
            where: { id: batch.id },
            data: {
              state: CleanupBatchState.FAILED,
              approvedByUcUid: ucUidOf(user as WithWorkspaceClaim),
              result: {
                completed: 0,
                failed: 0,
                bytes_freed: 0,
                total_attempted: 0,
                reason,
              } as any,
            },
          });
        },
      );
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
    await this.prisma.withWorkspace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      async (tx) => {
        await tx.cleanupBatch.update({
          where: { id: batch.id },
          data: {
            state: CleanupBatchState.COMPLETED,
            completedAt: new Date(),
            approvedByUcUid: ucUidOf(user as WithWorkspaceClaim),
            result: result.result as any,
            backupRef: result.backup_ref?.key ?? batch.backupRef,
            backupVerified: result.backup_ref?.verified ?? batch.backupVerified,
            archiveBucket: result.backup_ref?.bucket ?? (batch as any).archiveBucket ?? null,
            archiveKey: result.backup_ref?.key ?? (batch as any).archiveKey ?? null,
            archiveBytes: result.backup_ref?.bytes
              ? BigInt(result.backup_ref.bytes)
              : ((batch as any).archiveBytes ?? null),
            archiveSha256: result.backup_ref?.sha256 ?? (batch as any).archiveSha256 ?? null,
            archiveExpiresAt: result.backup_ref?.expires_at
              ? new Date(result.backup_ref.expires_at)
              : ((batch as any).archiveExpiresAt ?? null),
            archiveRetained: result.backup_ref?.retained ?? (batch as any).archiveRetained ?? false,
          },
        });
      },
    );
    return result;
  }

  async listCleanupActivity(user: User, provider: ConnectedProvider): Promise<CleanupBatchView[]> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    const rows = await this.prisma.withWorkspace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      (tx) =>
        tx.cleanupBatch.findMany({
          where: { workspaceId, provider },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
    );
    return rows.map((row) => this.batchView(row));
  }

  async getArchiveDownloadUrl(
    user: User,
    provider: ConnectedProvider,
    batchId: string,
  ): Promise<{ url: string; expires_in_seconds: number }> {
    const workspaceId = await this.resolveWorkspace(user);
    this.requireCleanerEntitlement(user, workspaceId);
    const batch = await this.prisma.withWorkspace(
      workspaceId,
      ucUidOf(user as WithWorkspaceClaim),
      (tx) =>
        tx.cleanupBatch.findFirst({
          where: { id: batchId, workspaceId, provider },
        }),
    );
    if (!batch || !this.archiveLive(batch)) {
      throw new NotFoundException('Live archive not found for this batch.');
    }
    const ttl = 900;
    return {
      url: await this.archiveStorage.presignGet(batch.archiveBucket!, batch.archiveKey!, ttl),
      expires_in_seconds: ttl,
    };
  }

  /** Shared pause fence for Cleaner writes staged as email-ops-agent. */
  private async assertAgentWriteAllowed(
    workspaceId: string,
    ucUid: string | null,
    agentKey: string,
  ): Promise<void> {
    const state = await this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const [workspace, agent] = await Promise.all([
        tx.workspace.findUnique({ where: { id: workspaceId }, select: { agentsPaused: true } }),
        tx.agent.findFirst({
          where: { workspaceId, key: agentKey, active: true },
          select: { paused: true },
        }),
      ]);
      return {
        agentsPaused: workspace?.agentsPaused ?? false,
        agentPaused: agent?.paused ?? false,
      };
    });
    if (state.agentsPaused) throw new ForbiddenException('Agents are paused for this workspace.');
    if (state.agentPaused) throw new ConflictException(`Agent '${agentKey}' is paused.`);
  }

  /**
   * The Cleaner Engine returns `null` from a cleanup call when the provider rejected
   * it (auth expired / rate-limited / transport error) — the engine surfaces that as
   * a non-2xx, which the client maps to null. That is NOT the same as "0 messages
   * matched" (a real `{ count: 0 }`). Treating null as 0 is how a failed cleanup used
   * to be recorded COMPLETED. Throw instead: the interactive path returns 502, and the
   * approval path's catch records the batch FAILED and keeps it retryable.
   */
  private assertEngineApplied(result: { count: number } | null, action: string): { count: number } {
    if (result === null) {
      throw new BadGatewayException(
        `The mail provider did not confirm the ${action} — it may be rate-limited or the sign-in ` +
          `may have expired. Nothing was recorded as done; try again.`,
      );
    }
    return result;
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
    const serverPlan = plan;
    const safeIds = new Set(serverPlan.safe.map((row) => row.id));
    const requested = (plan.safe.length ? plan.safe : serverPlan.safe)
      .map((row) => row.id)
      .filter((id) => safeIds.has(id));

    let count: { count: number } | null;
    let action: string;
    if (mode === 'trash') {
      action = 'trash';
      count = this.assertEngineApplied(
        await this.engine.batchTrash(
          provider,
          this.credentialsFor(provider, accessToken),
          requested,
        ),
        'trash',
      );
    } else if (mode === 'archive') {
      action = 'organize';
      count = this.assertEngineApplied(
        await this.engine.batchArchive(
          provider,
          this.credentialsFor(provider, accessToken),
          requested,
          typeof serverPlan.criteria.label === 'string' ? serverPlan.criteria.label : null,
        ),
        'organize',
      );
    } else if (mode === 'delete' || mode === 'archive_purge') {
      action = 'delete';
      const archiveRetained = options.archiveRetained ?? false;
      const archiveExpiresAt = archiveRetained ? null : this.daysFromNow(7);
      const archiveRef = await this.createVerifiedGarageArchive({
        workspaceId,
        provider,
        credentials: this.credentialsFor(provider, accessToken),
        messageIds: requested,
        batchId: options.batchId ?? randomUUID(),
        query: serverPlan.backup_query,
        archiveExpiresAt,
        archiveRetained,
      });
      count = this.assertEngineApplied(
        await this.engine.batchDelete(
          provider,
          this.credentialsFor(provider, accessToken),
          requested,
        ),
        'delete',
      );
      // NOTE: The engine returns a single count for batch operations, not per-ID failures.
      // Therefore, "failed" is an estimate: requested - completed. This is the best available
      // metric for partial successes (e.g. some IDs already gone).
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
        action,
        plan: serverPlan,
        result,
        backup_ref: archiveRef,
        status: 'completed',
      };
    } else if (mode === 'unsubscribe') {
      const senders = this.senderGroupFromCriteria(serverPlan.criteria as CleanupCriteria);
      const engineResult = await this.engine.unsubscribeSenders(
        provider,
        this.credentialsFor(provider, accessToken),
        senders,
      );
      if (!engineResult) {
        throw new BadGatewayException(
          'The mail provider did not confirm the unsubscribe — nothing was recorded as done.',
        );
      }
      const results = Array.isArray(engineResult.results) ? engineResult.results : [];
      const completed = results.filter((r) => r.status === 'unsubscribed').length;
      const failed = results.filter(
        (r) => r.status === 'failed' || r.status === 'unavailable',
      ).length;
      return {
        ok: true,
        provider,
        mode,
        batch_id: options.batchId ?? randomUUID(),
        action: 'unsubscribe',
        plan: serverPlan,
        result: this.cleanupResult({
          completed,
          failed,
          bytesFreed: 0,
          totalAttempted: results.length,
        }),
        status: 'completed',
        unsubscribe_results: results,
      };
    } else {
      throw new BadRequestException(
        `"${mode}" cleanup is not implemented — no messages were changed.`,
      );
    }
    // NOTE: The engine returns a single count for batch operations, not per-ID failures.
    // Therefore, "failed" is an estimate: requested - completed. This is the best available
    // metric for partial successes (e.g. some IDs already gone).
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
      action,
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
    state?: CleanupBatchState;
    plan: unknown;
    result: unknown;
    backupRef: string | null;
    backupVerified: boolean;
    archiveBucket?: string | null;
    archiveKey?: string | null;
    archiveBytes?: bigint | number | null;
    archiveSha256?: string | null;
    archiveExpiresAt?: Date | null;
    archiveRetained?: boolean;
  }): CleanupExecutionResult {
    // Reflect the batch's REAL terminal state — a re-read of a FAILED/UNDONE batch
    // must NOT masquerade as a fresh success (the truthful-UI contract). Only a
    // COMPLETED batch reports ok:true/completed.
    const status = this.batchStatusOf(batch.state);
    return {
      ok: status === 'completed' || status === 'undone',
      provider: batch.provider as ConnectedProvider,
      mode: batch.mode as CleanupWriteMode,
      batch_id: batch.id,
      action: batch.action.toLowerCase(),
      plan: batch.plan as unknown as CleanupPlanResult,
      result:
        (batch.result as CleanupExecutionResult['result']) ??
        this.cleanupResult({
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
            bucket: batch.archiveBucket ?? undefined,
            key: batch.archiveKey ?? undefined,
            bytes: batch.archiveBytes == null ? undefined : Number(batch.archiveBytes),
            sha256: batch.archiveSha256 ?? undefined,
            expires_at: batch.archiveExpiresAt?.toISOString() ?? null,
            retained: batch.archiveRetained ?? false,
          }
        : undefined,
      status,
    };
  }

  /** Map a persisted batch state → the wire `status` an approve/read returns. */
  private batchStatusOf(state?: CleanupBatchState): CleanupExecutionResult['status'] {
    switch (state) {
      case CleanupBatchState.FAILED:
        return 'failed';
      case CleanupBatchState.UNDONE:
        return 'undone';
      case CleanupBatchState.PENDING:
        return 'pending';
      case CleanupBatchState.COMPLETED:
      default:
        return 'completed';
    }
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
    archiveBucket?: string | null;
    archiveKey?: string | null;
    archiveBytes?: bigint | number | null;
    archiveSha256?: string | null;
    archiveExpiresAt?: Date | null;
    archiveRetained?: boolean;
    restoredAt?: Date | null;
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
      archive_bucket: row.archiveBucket ?? null,
      archive_key: row.archiveKey ?? null,
      archive_bytes: row.archiveBytes == null ? null : Number(row.archiveBytes),
      archive_sha256: row.archiveSha256 ?? null,
      archive_expires_at: row.archiveExpiresAt?.toISOString() ?? null,
      archive_retained: row.archiveRetained ?? false,
      restored_at: row.restoredAt?.toISOString() ?? null,
      undoable: this.archiveLive(row),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  private async createVerifiedGarageArchive(input: {
    workspaceId: string;
    provider: ConnectedProvider;
    credentials: Record<string, unknown>;
    messageIds: string[];
    batchId: string;
    query: string;
    archiveExpiresAt: Date | null;
    archiveRetained: boolean;
  }): Promise<CleanupExecutionBackupRef> {
    const key = this.archiveKey(input.workspaceId, input.provider, input.batchId);
    const archive = await this.engine.archiveCreate(
      input.provider,
      input.credentials,
      input.messageIds,
      { bucket: this.archiveStorage.bucket, key_prefix: key },
      {
        query: input.query,
        workspaceId: input.workspaceId,
        expiresAt: input.archiveExpiresAt?.toISOString() ?? null,
      },
    );
    if (!archive) {
      throw new ForbiddenException('Cleaner Engine unavailable while creating archive.');
    }
    const verification = await this.engine.archiveVerify(archive.bucket, archive.key);
    const verified = Boolean(verification?.success);
    if (!verified) {
      throw new ForbiddenException(
        `Archive verification failed: ${verification?.message ?? 'unknown error'}`,
      );
    }
    return {
      path: archive.key,
      bucket: archive.bucket,
      key: archive.key,
      verified,
      created_at: archive.created_at,
      total_messages: archive.total_messages,
      bytes: archive.bytes,
      sha256: archive.sha256,
      expires_at: input.archiveExpiresAt?.toISOString() ?? null,
      retained: input.archiveRetained,
    };
  }

  private async collectMessages(
    provider: ConnectedProvider,
    accessToken: string,
    criteria: CleanupCriteria,
  ): Promise<EngineMessageSummary[]> {
    const credentials = this.credentialsFor(provider, accessToken);
    const query = this.backupQueryFor(criteria);
    const perPage = Math.max(
      1,
      Math.min(Number(criteria.max_results ?? criteria.maxResults ?? 200), 500),
    );
    // An interactive plan is a bounded PREVIEW: cap how many messages a single
    // run reviews so the button returns in seconds, not minutes, on large
    // mailboxes. (Reviewing 2000 messages via serial metadata fetches took ~4min
    // and the client then aborted → the "cleanup does nothing" symptom.) A
    // comprehensive sweep is the scheduled/agent path, not this on-demand one.
    const reviewCap = Math.max(
      1,
      Math.min(
        Number(criteria.max_results ?? criteria.maxResults ?? REVIEW_PREVIEW_CAP),
        REVIEW_PREVIEW_CAP,
      ),
    );
    const messages: EngineMessageSummary[] = [];
    let pageToken: string | null | undefined = null;

    for (let page = 0; page < 10 && messages.length < reviewCap; page += 1) {
      const res = await this.engine.listMessages(
        provider,
        credentials,
        query,
        perPage,
        pageToken ?? null,
      );
      if (!res) {
        // The engine client maps any non-2xx (unsupported query, provider/Graph
        // failure, engine down) to null. A null FIRST page means the plan
        // reviewed nothing at all — letting that surface as reviewed:0
        // "success" would make a failed query indistinguishable from a clean
        // mailbox, so fail loudly instead. (collectMessages only serves the
        // cleanup lane — planCleanup and its callers; getInboxStats /
        // analyzeInbox use their own engine calls and keep degrading clean.)
        // A null LATER page degrades to the partial preview already collected.
        if (page === 0) {
          throw new ServiceUnavailableException(
            `Cleaner Engine could not list ${provider} messages for query "${query}" — cleanup plan aborted (a failed listing must never read as "nothing matched").`,
          );
        }
        break;
      }
      const pageMessages = Array.isArray(res.messages) ? res.messages : [];
      messages.push(...pageMessages);
      pageToken = res.next_token ?? null;
      if (!pageToken) break;
    }

    const capped = messages.slice(0, reviewCap);

    // Enrich message metadata in bounded-concurrency batches. Serial per-message
    // fetches of hundreds of messages were the difference between a ~5s plan and
    // a ~4min one; concurrency keeps the mailbox scan responsive without blowing
    // the provider rate limit.
    const enriched: EngineMessageSummary[] = new Array(capped.length);
    for (let i = 0; i < capped.length; i += ENRICH_CONCURRENCY) {
      const batch = capped.slice(i, i + ENRICH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (message) => {
          if (this.needsEnrichment(message)) {
            const full = await this.engine.getMessage(
              provider,
              credentials,
              message.id,
              'metadata',
            );
            return full ?? message;
          }
          return message;
        }),
      );
      for (let j = 0; j < results.length; j += 1) {
        enriched[i + j] = results[j];
      }
    }
    return enriched;
  }

  private needsEnrichment(message: EngineMessageSummary): boolean {
    // Absent-OR-null means UNKNOWN: the engine serialises Python None as JSON
    // null, so `=== undefined` alone missed it — Microsoft $search rows arrive
    // with size_bytes null (Graph drops the size expand under $search) and were
    // skipping enrichment, so the plan showed size 0 / freesBytes 0. `== null`
    // matches both null and undefined; concrete values (0 included) are known.
    return (
      !message.sender ||
      message.size_bytes == null ||
      message.is_starred == null ||
      message.labels == null
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
    const q = typeof criteria.query === 'string' ? criteria.query.trim() : '';
    if (q) return q;
    const senders = this.senderGroupFromCriteria(criteria);
    if (senders.length) {
      return senders.map((s) => `from:${s}`).join(' OR ');
    }
    // No free-text query: SCOPE the fetch to the selected categories so a plan
    // never pulls (and later classifies as "safe") the whole mailbox — including
    // personal and Sent mail. If no categories are given either, fall back to
    // promotions only; NEVER an unbounded all-mail scan.
    const categories = Array.isArray(criteria.categories) ? criteria.categories : [];
    const terms = [
      ...new Set(categories.map((c) => CATEGORY_QUERY[String(c).toLowerCase()]).filter(Boolean)),
    ];
    if (!terms.length) return 'category:promotions';
    return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
  }

  /**
   * Intersect the UI's explicit selection with the server-safe set.
   * - messageIds / message_ids present (including empty) → honour selection.
   * - absent → all safe rows (legacy / MCP criteria-only organize).
   */
  private selectedSafeIds(plan: CleanupPlanResult, criteria: CleanupCriteria): string[] {
    const safeIds = plan.safe.map((row) => row.id);
    const safeSet = new Set(safeIds);
    const raw = Array.isArray(criteria.messageIds)
      ? criteria.messageIds
      : Array.isArray(criteria.message_ids)
        ? criteria.message_ids
        : null;
    if (raw === null) return safeIds;
    return raw.map((id) => String(id)).filter((id) => safeSet.has(id));
  }

  private senderGroupFromCriteria(criteria: CleanupCriteria | Record<string, unknown>): string[] {
    const c = criteria as CleanupCriteria;
    if (Array.isArray(c.senderGroup)) return c.senderGroup.map(String).filter(Boolean);
    if (Array.isArray(c.sender_groups)) return c.sender_groups.map(String).filter(Boolean);
    return [];
  }

  /**
   * SAFETY GATE for what may be marked "safe to delete". A message qualifies only
   * when the user actually targeted it: either they gave a query the row VISIBLY
   * matches (a query alone is not enough — a provider that mistranslates or
   * silently ignores the filter had marked the user's own mail safe), or the
   * message carries one of the selected categories' labels. Everything else —
   * personal mail, Sent — is kept.
   */
  private isCleanupCandidate(
    row: CleanupPlanMessageView,
    message: EngineMessageSummary,
    categories: string[],
    query: string,
  ): boolean {
    if (query) return this.matchesQuery(row, message, query);
    if (!categories.length) return false;
    const wantedLabels = new Set(categories.flatMap((c) => CATEGORY_LABELS[c] ?? []));
    if (!wantedLabels.size) return false;
    const labels = Array.isArray(row.labels) ? row.labels.map((l) => String(l).toUpperCase()) : [];
    return labels.some((l) => wantedLabels.has(l));
  }

  /**
   * Client-side verification that a fetched row actually matches the user's
   * query. The provider is asked to scope the fetch, but a filter it dropped or
   * mistranslated must never turn into "everything fetched is safe" — a row that
   * does not visibly match is NOT a cleanup candidate (conservative).
   */
  private matchesQuery(
    row: CleanupPlanMessageView,
    message: EngineMessageSummary,
    query: string,
  ): boolean {
    // from:<addr> (possibly several, OR-joined): the sender address must equal
    // the value, or end on it as an @domain / .suffix boundary (quotes
    // stripped, case-insensitive). A bare substring test let from:shop.com
    // match x@myshop.company.
    const fromValues = [...query.matchAll(/(?:^|\s)from:("[^"]*"|\S+)/gi)]
      .map((m) => m[1].replace(/^"|"$/g, '').toLowerCase())
      .filter(Boolean);
    if (fromValues.length) {
      const senderAddress = this.extractAddress(row.sender).toLowerCase();
      return fromValues.some(
        (value) =>
          senderAddress === value ||
          senderAddress.endsWith(`@${value}`) ||
          senderAddress.endsWith(`.${value}`) ||
          (value.includes('@') && senderAddress.endsWith(value)),
      );
    }
    // Other operator queries (category:, is:, has:, older_than:) are enforced
    // server-side by the provider filter — or refused outright by the engine —
    // and are not visible in row metadata, so trust the scoped fetch. Anchored
    // to start-or-whitespace so free text like "check-in: reminder" doesn't
    // read as an operator.
    if (/(?:^|\s)(?:category|is|has|older_than|label|in):/i.test(query)) return true;
    // Free text: the row must visibly contain the text in sender, subject or snippet.
    const needle = query.toLowerCase();
    const snippet = typeof message.snippet === 'string' ? message.snippet : null;
    return [row.sender, row.subject, snippet].some(
      (haystack) => typeof haystack === 'string' && haystack.toLowerCase().includes(needle),
    );
  }

  private batchSummary(
    mode: string,
    provider: ConnectedProvider,
    count: number,
    backupRef: string | null,
  ): string {
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

  private extractAddress(sender: string | null): string {
    if (!sender) return '';
    const match = sender.match(/<([^>]+)>/);
    return (match?.[1] ?? sender).trim();
  }

  private extractDomain(sender: string | null): string {
    const address = this.extractAddress(sender);
    const at = address.lastIndexOf('@');
    if (at < 0) return '';
    return address
      .slice(at + 1)
      .trim()
      .toLowerCase();
  }

  private async resolveWorkspace(user: User): Promise<string> {
    return this.membership.resolveAndAuthorize(user, null);
  }

  private async requireAccessToken(user: User, provider: ConnectedProvider): Promise<string> {
    const accessToken = await this.safeBrokerToken(user, provider);
    if (!accessToken) {
      throw new ForbiddenException(`no linked ${provider} account — sign in via ${provider} first`);
    }
    return accessToken;
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

  private hasVaultEntitlement(user: User, workspaceId: string): boolean {
    return checkVaultEntitlement(this.entitlementsOf(user), workspaceId).allowed;
  }

  private daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  private archiveKey(workspaceId: string, provider: ConnectedProvider, batchId: string): string {
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    return `workspaces/${workspaceId}/archives/${provider}/${batchId}-${iso}.eml.zip`;
  }

  private archiveLive(batch: {
    archiveKey?: string | null;
    archiveBucket?: string | null;
    archiveExpiresAt?: Date | null;
    archiveRetained?: boolean | null;
    restoredAt?: Date | null;
  }): boolean {
    if (!batch.archiveKey || !batch.archiveBucket) return false;
    if (batch.restoredAt) return false;
    if (batch.archiveRetained) return true;
    return !!batch.archiveExpiresAt && batch.archiveExpiresAt.getTime() > Date.now();
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

  private credentialsFor(
    provider: ConnectedProvider,
    accessToken: string,
  ): Record<string, unknown> {
    return provider === 'gmail' ? { token: accessToken } : { access_token: accessToken };
  }
}
