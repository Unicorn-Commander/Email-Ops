import { API_BASE, ApiError, apiGet, apiPost, getToken } from '@/lib/api';

export type MailSecurity = 'ssl' | 'starttls' | 'none';

export interface ManualClientSettings {
  client: string;
  steps: string[];
  fields: {
    imapHost: string;
    imapPort: number;
    imapSecurity: MailSecurity;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: MailSecurity;
    username: string;
  };
}

export interface DeviceConnectionSettings {
  email: string;
  displayName: string | null;
  username: string;
  imap: { host: string; port: number; security: MailSecurity };
  smtp: { host: string; port: number; security: MailSecurity };
  jmap: { url: string | null };
  notes: string[];
  manual: ManualClientSettings[];
}

const mailboxPath = (workspaceId: string, mailboxId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/mailboxes/${encodeURIComponent(mailboxId)}`;

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  } catch {
    /* non-JSON body */
  }
  return fallback;
}

export async function getConnection(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<DeviceConnectionSettings> {
  return apiGet<DeviceConnectionSettings>(`${mailboxPath(workspaceId, mailboxId)}/connection`, token);
}

export async function fetchMobileconfigBlob(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<Blob> {
  const bearer = token ?? getToken();
  const res = await fetch(`${API_BASE}${mailboxPath(workspaceId, mailboxId)}/config.mobileconfig`, {
    credentials: 'include',
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      await errorMessage(res, `GET config.mobileconfig failed: ${res.status}`),
    );
  }
  return res.blob();
}

export async function resetAppPassword(
  workspaceId: string,
  mailboxId: string,
  token?: string,
): Promise<{ password: string }> {
  return apiPost<{ password: string }>(`${mailboxPath(workspaceId, mailboxId)}/app-password:reset`, {}, token);
}
