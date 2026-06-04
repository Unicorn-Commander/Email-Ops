export interface EngineProfile {
  email: string;
  display_name: string | null;
  total_messages: number;
  total_threads: number;
  storage_used_bytes: number;
  storage_limit_bytes: number;
  [key: string]: unknown;
}

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

export interface ConnectedAccountView {
  id: string;
  workspaceId: string;
  provider: string;
  emailAddress: string;
  displayName: string | null;
  status: string;
  credentialsExpireAt: string | null;
  lastAnalyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedAccountStatsResult {
  engineAvailable: boolean;
  account: ConnectedAccountView;
  inboxStats: EngineInboxStats | null;
  reason?: string;
}

export interface ConnectedAccountAnalysisResult {
  engineAvailable: boolean;
  account: ConnectedAccountView;
  analysis: Record<string, unknown> | null;
  reason?: string;
}
