import { apiGet, apiPost } from '@/lib/api';

export interface MailDomainView {
  id: string;
  domain: string;
  verified: boolean;
  verificationRequestedAt: string | null;
  verifiedAt: string | null;
  lastVerificationCheckAt: string | null;
  lastVerificationError: string | null;
  recordName: string | null;
  recordType: 'TXT' | null;
  recordValue: string | null;
}

export interface MailDomainListResponse {
  items: MailDomainView[];
  count: number;
}

export interface MailDomainVerificationChallenge {
  recordName: string;
  recordType: 'TXT';
  recordValue: string;
}

const domainsBase = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/mail-domains`;

export async function listMailDomains(
  workspaceId: string,
  token?: string,
): Promise<MailDomainListResponse> {
  return apiGet<MailDomainListResponse>(domainsBase(workspaceId), token);
}

export async function requestMailDomainVerification(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<MailDomainVerificationChallenge> {
  return apiPost<MailDomainVerificationChallenge>(
    `${domainsBase(workspaceId)}/${encodeURIComponent(id)}/verification`,
    {},
    token,
  );
}

export async function checkMailDomainVerification(
  workspaceId: string,
  id: string,
  token?: string,
): Promise<MailDomainView> {
  return apiPost<MailDomainView>(
    `${domainsBase(workspaceId)}/${encodeURIComponent(id)}/verification/check`,
    {},
    token,
  );
}
