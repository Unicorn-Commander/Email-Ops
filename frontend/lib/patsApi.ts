/**
 * Session-authenticated API tokens. Paths are relative to `API_BASE`
 * (`/api/v1`). The plaintext `token` exists only in the create response.
 */

import { apiDelete, apiGet, apiPost } from './api';
import { PATS_PATH, type CreatePatBody, type PatListItem } from './patForm';

export { PATS_PATH };

export interface CreatedPat {
  id: string;
  name: string;
  token: string;
  token_prefix: string;
  scopes: string[];
  expires_at: string;
  created_at: string;
}

interface PatListResponse {
  items?: PatListItem[];
}

export function listPats(): Promise<PatListItem[]> {
  return apiGet<PatListResponse>(PATS_PATH).then((body) => (Array.isArray(body.items) ? body.items : []));
}

export function createPat(body: CreatePatBody): Promise<CreatedPat> {
  return apiPost<CreatedPat>(PATS_PATH, body);
}

export function revokePat(id: string): Promise<unknown> {
  return apiDelete(`${PATS_PATH}/${encodeURIComponent(id)}`);
}
