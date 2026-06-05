export type ConnectedProvider = 'gmail' | 'microsoft';

export interface EngineInboxStats {
  total_messages: number;
  total_threads: number;
  unread_count: number;
  promotional_count: number;
  social_count: number;
  storage_used_bytes: number;
  storage_limit_bytes?: number;
  [key: string]: unknown;
}

export interface LinkedAccountView {
  provider: ConnectedProvider;
  linked: boolean;
}

export interface ConnectedAccountsListResult {
  accounts: LinkedAccountView[];
}

export interface ProviderUnavailableResult {
  available: false;
  provider: ConnectedProvider;
  reason: string;
}

export interface ProviderInboxStatsResult {
  available: true;
  provider: ConnectedProvider;
  stats: EngineInboxStats;
}

export interface ProviderAnalysisResult {
  available: true;
  provider: ConnectedProvider;
  analysis: Record<string, unknown>;
}

export type ConnectedAccountsStatsResult = ProviderUnavailableResult | ProviderInboxStatsResult;
export type ConnectedAccountsAnalysisResult = ProviderUnavailableResult | ProviderAnalysisResult;
