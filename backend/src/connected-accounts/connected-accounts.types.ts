export type ConnectedProvider = 'gmail' | 'microsoft';

export type CleanupMode = 'trash' | 'delete' | 'archive_purge';
export type CleanupWriteMode = CleanupMode | 'archive' | 'label' | 'unsubscribe' | 'undo';

export interface EngineMessageSummary {
  id: string;
  thread_id?: string | null;
  subject?: string | null;
  sender?: string | null;
  recipient?: string | null;
  date?: string | null;
  snippet?: string | null;
  labels?: string[];
  is_read?: boolean;
  is_starred?: boolean;
  has_attachments?: boolean;
  size_bytes?: number;
  internal_date?: number | null;
  headers?: Record<string, string>;
  raw_data?: unknown;
  [key: string]: unknown;
}

export interface EngineListMessagesResult {
  messages: EngineMessageSummary[];
  next_token?: string | null;
}

export interface EngineBackupManifest {
  version: string;
  created_at: string;
  query: string;
  total_messages: number;
  errors: number;
  path: string;
  provider: string;
}

export interface EngineArchiveRef {
  bucket: string;
  key: string;
  format: string;
  total_messages: number;
  bytes: number;
  content_bytes?: number;
  sha256: string;
  created_at: string;
}

export interface EngineArchiveVerifyResult {
  success: boolean;
  total_messages: number;
  bytes: number;
  sha256?: string;
  message: string;
}

export interface EngineArchiveRestoreResult {
  restored: number;
  failed: Array<{ id?: string; error?: string }> | number;
}

export interface CleanupPlanMessageView {
  id: string;
  sender: string | null;
  subject: string | null;
  date: string | null;
  size_bytes: number;
  starred: boolean;
  labels: string[];
  protected: boolean;
  reason: string | null;
}

export interface CleanupPlanCounts {
  reviewed: number;
  safe: number;
  protected: number;
}

export interface CleanupPlanResult {
  provider: ConnectedProvider;
  criteria: Record<string, unknown>;
  counts: CleanupPlanCounts;
  freesBytes: number;
  protected: CleanupPlanMessageView[];
  safe: CleanupPlanMessageView[];
  backup_query: string;
}

export interface CleanupExecutionBackupRef {
  path: string;
  verified: boolean;
  created_at: string | null;
  total_messages: number;
  bucket?: string;
  key?: string;
  bytes?: number;
  sha256?: string;
  expires_at?: string | null;
  retained?: boolean;
  download_url?: string | null;
}

export interface CleanupExecutionResult {
  ok: boolean;
  provider: ConnectedProvider;
  mode: CleanupWriteMode;
  batch_id: string;
  action: string;
  plan: CleanupPlanResult;
  result: {
    completed: number;
    failed: number;
    bytes_freed: number;
    total_attempted: number;
  };
  backup_ref?: CleanupExecutionBackupRef | null;
  status: 'completed' | 'pending' | 'rejected' | 'failed' | 'undone';
  staged?: boolean;
  staged_item_id?: string | null;
  reason?: string | null;
}

export interface CleanupBatchView {
  id: string;
  provider: ConnectedProvider;
  action: string;
  mode: CleanupWriteMode;
  state: string;
  summary: string;
  params: string;
  result: string;
  backup_ref: string | null;
  archive_bucket?: string | null;
  archive_key?: string | null;
  archive_bytes?: number | null;
  archive_sha256?: string | null;
  archive_expires_at?: string | null;
  archive_retained?: boolean;
  restored_at?: string | null;
  undoable: boolean;
  created_at: string;
  updated_at: string;
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
