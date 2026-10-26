/**
 * API-token form rules. Field names match POST /api/v1/auth/pats:
 * `scopes` is required, `expires_in_days` defaults to 90 and caps at 365.
 */

export const PAT_SCOPES = [
  { id: 'mail:read', label: 'Read mail', detail: 'List threads and read messages.' },
  {
    id: 'mail:write',
    label: 'Send and change mail',
    detail: 'Lets an agent send mail.',
    warnsSend: true,
  },
  { id: 'agent-inbox:read', label: 'Read the approval queue', detail: 'See drafts waiting for you.' },
  {
    id: 'agent-inbox:approve',
    label: 'Approve the queue',
    detail: 'Approve or reject drafts. Approving a send lets it leave.',
  },
  { id: 'cleaner:run', label: 'Run cleanup', detail: 'Stage cleanup plans for your approval.' },
  { id: 'admin:provision', label: 'Provision', detail: 'Provision mailboxes and domains.' },
  { id: 'ui:control', label: 'Drive the app', detail: 'Open screens and prefill the composer. You still press Send.' },
] as const;

export type PatScopeId = (typeof PAT_SCOPES)[number]['id'];

/** Least privilege for a reader: mail plus the approval queue. Not send. */
export const DEFAULT_PAT_SCOPES: PatScopeId[] = ['mail:read', 'agent-inbox:read'];

export const DEFAULT_EXPIRES_IN_DAYS = 90;
export const MAX_EXPIRES_IN_DAYS = 365;

/** Relative to `API_BASE` (`/api/v1`). Session cookie, not a PAT. */
export const PATS_PATH = '/auth/pats';

export interface CreatePatBody {
  name: string;
  scopes: string[];
  expires_in_days: number;
}

export function buildCreatePatBody(input: {
  name: string;
  scopes: readonly string[];
  expiresInDays: number;
}): CreatePatBody | { error: string } {
  const name = input.name.trim();
  if (!name) return { error: 'Name the token.' };
  if (name.length > 120) return { error: 'Use a name of 120 characters or fewer.' };
  const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (scopes.length === 0) return { error: 'Pick at least one scope.' };
  const days = input.expiresInDays;
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRES_IN_DAYS) {
    return { error: `Expiry must be a whole number of days from 1 to ${MAX_EXPIRES_IN_DAYS}.` };
  }
  return { name, scopes, expires_in_days: days };
}

export function isCreatePatBody(value: CreatePatBody | { error: string }): value is CreatePatBody {
  return !('error' in value);
}

/** Strip a minted secret out of a message before it is shown. */
export function redactSecrets(text: string): string {
  return text.replace(/eo_pat_[A-Za-z0-9]+/g, 'eo_pat_…');
}

export interface PatListItem {
  id: string;
  name: string;
  token_prefix?: string | null;
  scopes?: string[] | null;
  created_at?: string | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
}

export interface RememberedPatMeta {
  scopes: string[];
  expires_at: string | null;
}

/**
 * Scopes and expiry for a row. Prefer what the list endpoint returned.
 * A token minted in this page session can fill those fields from the create
 * response until a reload — that response is not the secret.
 */
export function rowScopes(item: PatListItem, remembered?: RememberedPatMeta): string[] | null {
  if (Array.isArray(item.scopes)) return item.scopes;
  if (remembered && remembered.scopes.length > 0) return remembered.scopes;
  return null;
}

export function rowExpiresAt(item: PatListItem, remembered?: RememberedPatMeta): string | null {
  if (typeof item.expires_at === 'string' && item.expires_at.length > 0) return item.expires_at;
  if (remembered?.expires_at) return remembered.expires_at;
  return null;
}
