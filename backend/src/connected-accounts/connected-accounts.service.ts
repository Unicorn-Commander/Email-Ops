import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService, WorkspaceTxClient } from '../prisma/prisma.service';
import { ConnectedAccountsEnginePort } from './connected-accounts.port';
import {
  ConnectedAccountAnalysisResult,
  ConnectedAccountStatsResult,
  ConnectedAccountView,
  EngineProfile,
} from './connected-accounts.types';
import { decrypt, encrypt, isEncryptionConfigured } from './crypto';

type ConnectedAccountRow = {
  id: string;
  workspaceId: string;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  encryptedCredentials: string;
  credentialsExpireAt: Date | null;
  lastAnalyzedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ConnectedAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: ConnectedAccountsEnginePort,
  ) {}

  async listConnectedAccounts(
    workspaceId: string,
    ucUid: string | null,
  ): Promise<{ accounts: ConnectedAccountView[]; count: number }> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const rows = await tx.connectedAccount.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          workspaceId: true,
          provider: true,
          emailAddress: true,
          displayName: true,
          status: true,
          credentialsExpireAt: true,
          lastAnalyzedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const accounts = rows.map((row) => this.toView(row as unknown as ConnectedAccountRow));
      return { accounts, count: accounts.length };
    });
  }

  async connectAccount(
    workspaceId: string,
    ucUid: string | null,
    input: { provider: string; code: string; redirectUri: string },
  ): Promise<ConnectedAccountView> {
    const provider = this.normalizeProvider(input.provider);
    if (!isEncryptionConfigured()) {
      throw new ServiceUnavailableException(
        'Connected account encryption is not configured (CONNECTED_ACCOUNT_ENC_KEY is required)',
      );
    }
    if (!this.engine.isConfigured()) {
      throw new ServiceUnavailableException('Cleaner Engine is not configured');
    }

    const credentials = await this.engine.exchangeCode(provider, input.code, input.redirectUri);
    if (!credentials) {
      throw new ServiceUnavailableException('Cleaner Engine OAuth exchange failed');
    }

    const profile = await this.engine.getProfile(provider, credentials);
    if (!profile) {
      throw new ServiceUnavailableException('Cleaner Engine profile lookup failed');
    }

    const emailAddress = this.profileEmail(profile);
    if (!emailAddress) {
      throw new BadRequestException('Cleaner Engine profile did not include an email address');
    }

    const displayName = this.profileDisplayName(profile);
    let encryptedCredentials: string;
    try {
      encryptedCredentials = encrypt(credentials);
    } catch (err) {
      throw new ServiceUnavailableException((err as Error).message);
    }
    const credentialsExpireAt = this.extractExpiry(credentials);

    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const row = await tx.connectedAccount.upsert({
        where: {
          workspaceId_provider_emailAddress: {
            workspaceId,
            provider,
            emailAddress,
          },
        },
        update: {
          displayName,
          status: 'active',
          encryptedCredentials,
          credentialsExpireAt,
        },
        create: {
          workspaceId,
          provider,
          emailAddress,
          displayName,
          status: 'active',
          encryptedCredentials,
          credentialsExpireAt,
        },
      });

      return this.toView(row as unknown as ConnectedAccountRow);
    });
  }

  async getInboxStats(
    workspaceId: string,
    ucUid: string | null,
    accountId: string,
  ): Promise<ConnectedAccountStatsResult> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const account = await this.loadAccount(tx, accountId);
      const view = this.toView(account);
      if (!this.engine.isConfigured()) {
        return {
          engineAvailable: false,
          account: view,
          inboxStats: null,
          reason: 'Cleaner Engine is not configured',
        };
      }

      const credentials = this.safeDecrypt(account.encryptedCredentials);
      if (!credentials) {
        return {
          engineAvailable: false,
          account: view,
          inboxStats: null,
          reason: 'Connected account credentials could not be decrypted',
        };
      }

      const stats = await this.engine.getInboxStats(account.provider, credentials);
      if (!stats) {
        return {
          engineAvailable: false,
          account: view,
          inboxStats: null,
          reason: 'Cleaner Engine inbox stats unavailable',
        };
      }

      return {
        engineAvailable: true,
        account: view,
        inboxStats: stats,
      };
    });
  }

  async analyzeInbox(
    workspaceId: string,
    ucUid: string | null,
    accountId: string,
  ): Promise<ConnectedAccountAnalysisResult> {
    return this.prisma.withWorkspace(workspaceId, ucUid, async (tx) => {
      const account = await this.loadAccount(tx, accountId);
      const view = this.toView(account);
      if (!this.engine.isConfigured()) {
        return {
          engineAvailable: false,
          account: view,
          analysis: null,
          reason: 'Cleaner Engine is not configured',
        };
      }

      const credentials = this.safeDecrypt(account.encryptedCredentials);
      if (!credentials) {
        return {
          engineAvailable: false,
          account: view,
          analysis: null,
          reason: 'Connected account credentials could not be decrypted',
        };
      }

      const analysis = await this.engine.analyzeInbox(account.provider, credentials);
      if (!analysis) {
        return {
          engineAvailable: false,
          account: view,
          analysis: null,
          reason: 'Cleaner Engine analysis unavailable',
        };
      }

      const updated = (await tx.connectedAccount.update({
        where: { id: account.id },
        data: { lastAnalyzedAt: new Date() },
      })) as unknown as ConnectedAccountRow;

      return {
        engineAvailable: true,
        account: this.toView(updated),
        analysis,
      };
    });
  }

  private normalizeProvider(provider: string): 'gmail' | 'microsoft' {
    const normalized = (provider ?? '').trim().toLowerCase();
    if (normalized === 'gmail' || normalized === 'microsoft') {
      return normalized;
    }
    throw new BadRequestException('provider must be gmail or microsoft');
  }

  private profileEmail(profile: EngineProfile): string | null {
    const raw = profile.email ?? (profile as unknown as Record<string, unknown>)['emailAddress'];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  private profileDisplayName(profile: EngineProfile): string | null {
    const raw = profile.display_name ?? (profile as unknown as Record<string, unknown>)['displayName'];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  private extractExpiry(credentials: Record<string, unknown>): Date | null {
    const keys = ['credentialsExpireAt', 'credentials_expire_at', 'expiresAt', 'expires_at', 'expiry'];
    for (const key of keys) {
      const value = credentials[key];
      const parsed = this.toDate(value);
      if (parsed) return parsed;
    }
    return null;
  }

  private toDate(value: unknown): Date | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string' && value.trim()) {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  private safeDecrypt(payload: string): Record<string, unknown> | null {
    try {
      return decrypt<Record<string, unknown>>(payload);
    } catch {
      return null;
    }
  }

  private async loadAccount(tx: WorkspaceTxClient, accountId: string): Promise<ConnectedAccountRow> {
    const account = (await tx.connectedAccount.findUnique({
      where: { id: accountId },
    })) as ConnectedAccountRow | null;
    if (!account) {
      throw new NotFoundException('Connected account not found');
    }
    return account;
  }

  private toView(row: ConnectedAccountRow): ConnectedAccountView {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      emailAddress: row.emailAddress,
      displayName: row.displayName,
      status: row.status,
      credentialsExpireAt: row.credentialsExpireAt ? row.credentialsExpireAt.toISOString() : null,
      lastAnalyzedAt: row.lastAnalyzedAt ? row.lastAnalyzedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
