/** Maximum size accepted for a data URI before it is discarded at the auth boundary. */
export const AVATAR_DATA_URI_MAX_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function claimValues(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Normalize one untrusted avatar claim. Remote avatars must be valid HTTPS
 * URLs; data URLs are rejected so a token cannot turn into an oversized or
 * executable browser payload. The explicit size guard keeps oversized data
 * URIs out of persistence even when callers inspect this boundary first.
 */
export function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate) return null;

  if (/^data:/i.test(candidate)) {
    if (Buffer.byteLength(candidate, 'utf8') > AVATAR_DATA_URI_MAX_BYTES) return null;
    return null;
  }

  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Read the standard OIDC picture claim first, then the flat/nested Keycloak
 * user-attribute forms used by existing client-scope mappers.
 */
export function avatarUrlFromClaims(profile: unknown): string | null {
  if (!isRecord(profile)) return null;
  const attributes = isRecord(profile.attributes) ? profile.attributes : null;
  const candidates = [
    ...claimValues(profile.picture),
    ...claimValues(profile.avatar_url),
    ...(attributes ? claimValues(attributes.avatar_url) : []),
    ...(attributes ? claimValues(attributes.picture) : []),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeAvatarUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}
