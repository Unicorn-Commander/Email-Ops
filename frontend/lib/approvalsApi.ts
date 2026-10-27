import { apiGet, apiPost } from "./api";

export interface StandingApproval {
  id: string;
  campaignKey: string;
  mailboxId: string;
  fromAddress: string;
  templateSha256: string;
  definitionSha256: string;
  bodyTemplate: string;
  subjects: string[];
  placeholderRules: Record<string, string>;
  optionalLines: number[];
  recipientRules: { blockedDomains: string[]; allowedDomains: string[] };
  capPerDay: number;
  expiresAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
  approval_url: string | null;
  usedToday: number;
}

export interface ApprovalKit {
  kitId: string;
  title: string;
  fromAddress: string;
  templateSha256: string;
  bodyTemplate: string;
  subjects: string[];
  recipients: string[];
  recipientHashes: string[];
  placeholderRules: Record<string, string>;
  optionalLines: number[];
  capPerDay: number;
  expiresAt: string;
}

export interface ApprovalPreview {
  kind: "send-kit" | "standing";
  kit: ApprovalKit | null;
  standing: StandingApproval | null;
  canRemember: boolean;
}

export interface ApprovalLocation {
  workspace: string;
  kind: string;
  id: string;
  token: string;
}
export function approvalAction<T>(
  location: ApprovalLocation,
  action: "preview" | "approve",
  remember = false,
) {
  const path = `/approvals/${encodeURIComponent(location.workspace)}/${encodeURIComponent(location.kind)}/${encodeURIComponent(location.id)}/${action}`;
  return apiPost<T>(path, { token: location.token, remember }, undefined, {
    "X-Email-Ops-Approval": "1",
  });
}

const standingBase = (workspace: string) =>
  `/workspaces/${encodeURIComponent(workspace)}/standing-approvals`;
export const listStandingApprovals = (workspace: string) =>
  apiGet<{ items: StandingApproval[] }>(standingBase(workspace));
export const requestStandingApproval = (
  workspace: string,
  body: {
    campaign_key: string;
    mailbox_id: string;
    subject: string;
    body_template: string;
    cap_per_day: number;
    expires_at: string;
    recipient_rules: { blockedDomains: string[]; allowedDomains: string[] };
  },
) => apiPost<StandingApproval>(standingBase(workspace), body);
export const revokeStandingApproval = (workspace: string, id: string) =>
  apiPost(`${standingBase(workspace)}/${encodeURIComponent(id)}/revoke`);

export function approvalReturnPath(): string {
  const path = window.sessionStorage.getItem("email-ops:approval-return");
  window.sessionStorage.removeItem("email-ops:approval-return");
  return path?.startsWith("/approve#") ? path : "/dashboard";
}
