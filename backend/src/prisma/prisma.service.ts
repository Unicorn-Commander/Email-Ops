import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The subset of PrismaClient passed into a withWorkspace() callback: a
 * transaction-scoped client. It is the same surface as `prisma.$transaction`'s
 * interactive-transaction argument, so callers use it exactly like `this.prisma`.
 */
export type WorkspaceTxClient = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * BYPASSRLS system connection.
   *
   * This client MUST stay limited to the documented cross-tenant resolvers that
   * have no workspace id at call time:
   *   1. Postmark providerMessageId -> email message workspace resolver.
   *   2. Twilio inbound toPhoneNumber -> SMS account workspace resolver.
   *   3. Archive-retention expired cleanup batch scanner.
   *
   * Never use this for user-facing reads or writes. Follow-on mutations must
   * run through withWorkspace(resolvedWorkspaceId, ...) on the normal client.
   */
  readonly systemClient: PrismaClient;

  constructor() {
    super();
    const systemUrl = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL;
    this.systemClient = new PrismaClient(
      systemUrl
        ? {
            datasources: {
              db: { url: systemUrl },
            },
          }
        : undefined,
    );
  }

  async onModuleInit() {
    if (this.tenancyEnabled() && !process.env.ADMIN_DATABASE_URL) {
      throw new Error(
        'ADMIN_DATABASE_URL is required when EMAIL_OPS_TENANCY_ENABLED=true; system resolvers need a documented BYPASSRLS connection.',
      );
    }
    await this.$connect();
    this.logger.log('Database connected successfully');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  async $connect(): Promise<void> {
    await super.$connect();
    await this.systemClient.$connect();
  }

  async $disconnect(): Promise<void> {
    await super.$disconnect();
    await this.systemClient.$disconnect();
  }

  private tenancyEnabled(): boolean {
    const value = (process.env.EMAIL_OPS_TENANCY_ENABLED ?? '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes' || value === 'on';
  }

  /**
   * Run `fn` inside a transaction with the per-request tenancy GUCs set, so
   * Postgres Row Level Security scopes every query to `workspaceId`.
   *
   * This is the GUC chokepoint of the suite tenancy model (SUITE-IDENTITY §6).
   * It opens an interactive `$transaction`, sets the two session GUCs with
   * `is_local = true` (== `SET LOCAL`, so they reset automatically at
   * COMMIT/ROLLBACK and can never leak onto a pooled connection's next checkout),
   * then invokes `fn` with the transaction client. All reads/writes inside `fn`
   * MUST go through the passed `tx`, not `this`, or they bypass the GUC.
   *
   *   await prisma.withWorkspace(workspaceId, ucUid, (tx) =>
   *     tx.emailMessage.findMany());
   *
   * ROLLOUT NOTE (Phase 1): RLS is created-but-inert because the running app
   * still connects as the table owner (which is BYPASSRLS). This method is the
   * forward-compatible write path — mandatory once the runtime DATABASE_URL is
   * flipped to the NOBYPASSRLS `email_ops_app` role. Setting the GUCs now is
   * harmless and correct under the owner connection (the policy simply isn't
   * enforced yet), so callers can adopt it incrementally without a behavior
   * change.
   *
   * @param workspaceId resolved canonical workspace id (uc-registry uuidv7).
   * @param ucUid       acting user's uchub `sub` (for `app.uc_uid` attribution);
   *                    pass '' / null when unknown (e.g. system jobs).
   * @param fn          handler receiving the transaction-scoped Prisma client.
   * @param options     optional Prisma interactive-transaction options.
   */
  async withWorkspace<T>(
    workspaceId: string,
    ucUid: string | null | undefined,
    fn: (tx: WorkspaceTxClient) => Promise<T>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ): Promise<T> {
    if (!workspaceId || !workspaceId.trim()) {
      // Fail closed: an empty workspace id would set the GUC to '' (==NULL via
      // current_workspace_id()) and, under live RLS, expose zero rows while
      // silently succeeding. Surfacing it as an error here makes the
      // misconfiguration loud instead of a confusing empty result set.
      throw new Error('withWorkspace requires a non-empty workspaceId');
    }

    return this.$transaction(async (tx) => {
      // set_config(setting, value, is_local) — is_local=true => SET LOCAL,
      // scoped to this transaction only. Parameterized to prevent injection.
      await tx.$executeRaw`SELECT set_config('app.current_workspace', ${workspaceId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.uc_uid', ${ucUid ?? ''}, true)`;
      return fn(tx);
    }, options);
  }
}
