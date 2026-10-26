/**
 * Canonical MCP URL for whichever ring this frontend was built for.
 *
 * The host comes from `NEXT_PUBLIC_API_URL` (exposed as `API_BASE` in
 * `lib/api.ts`). When that env is unset the app calls the API same-origin at
 * `/api/v1`, and the page origin supplies the host. Nothing here names a ring.
 */

/** `NEXT_PUBLIC_API_URL`, or same-origin `/api/v1` when it is unset. */
export function mcpUrlFromApiBase(apiBase: string, pageOrigin?: string | null): string {
  const base = apiBase.trim();
  if (/^https?:\/\//i.test(base)) {
    try {
      return `${new URL(base).origin}/api/v1/mcp`;
    } catch {
      /* malformed absolute base — fall through to the page origin */
    }
  }
  const origin = (pageOrigin ?? '').trim().replace(/\/+$/, '');
  return `${origin}/api/v1/mcp`;
}
