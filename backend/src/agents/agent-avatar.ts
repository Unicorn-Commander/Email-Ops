/**
 * Agent avatar resolution — ONE rule, mirrored by every surface that renders an
 * agent identity (the generated outbound signature here in the backend; the
 * cockpit chips via frontend/components/AgentAvatar.tsx):
 *
 *   avatar = agents.avatarUrl when set
 *          → else /agent-avatars/<key>.svg when a shipped placeholder exists
 *          → else /agent-avatars/default.svg
 *
 * The placeholder files live in frontend/public/agent-avatars/ (publicly served
 * by the app at /agent-avatars/<file>). PLACEHOLDER_AVATAR_KEYS mirrors that
 * directory — the backend can't stat the frontend's public dir at runtime, so
 * when you drop a new per-key file in, add the key here too (the frontend needs
 * no list: it just tries the per-key path and falls back onError).
 *
 * Outbound MAIL needs an ABSOLUTE URL (a mail client has no origin to resolve
 * a relative path against): EMAIL_OPS_PUBLIC_BASE_URL, defaulting to the
 * canonical public app origin. Env is read via an injectable EnvGetter (the
 * agent-reply.flags.ts pattern) so unit tests never mutate real process.env
 * semantics beyond the standard set/delete dance.
 */

type EnvGetter = (key: string) => string | undefined;

const defaultGetter: EnvGetter = (k) => process.env[k];

/** The canonical public origin the app is served from (used when env is unset). */
export const DEFAULT_PUBLIC_BASE_URL = 'https://email-ops.magicunicorn.dev';

/** Where the avatar files are served from, app-relative. */
export const AGENT_AVATARS_PATH = '/agent-avatars';

/**
 * The agent keys with a shipped per-key placeholder file in
 * frontend/public/agent-avatars/. Keep in sync with that directory (its
 * README.md documents the drop-in flow).
 */
export const PLACEHOLDER_AVATAR_KEYS: ReadonlySet<string> = new Set([
  'perry',
  'prudence',
  'corporal-qwen',
]);

/** The public app origin for absolute links in outbound mail (no trailing slash). */
export function publicBaseUrl(getEnv: EnvGetter = defaultGetter): string {
  const raw = (getEnv('EMAIL_OPS_PUBLIC_BASE_URL') ?? '').trim();
  return (raw || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

/**
 * The resolution rule, app-relative form (unless avatarUrl is already absolute):
 * avatarUrl → known per-key placeholder → default.svg.
 */
export function agentAvatarPath(agent: {
  key?: string | null;
  avatarUrl?: string | null;
}): string {
  const own = agent.avatarUrl?.trim();
  if (own) return own;
  const key = agent.key?.trim().toLowerCase() ?? '';
  if (key && PLACEHOLDER_AVATAR_KEYS.has(key)) {
    return `${AGENT_AVATARS_PATH}/${key}.svg`;
  }
  return `${AGENT_AVATARS_PATH}/default.svg`;
}

/**
 * The ABSOLUTE avatar URL for outbound signatures. An already-absolute
 * avatarUrl is used verbatim; anything relative is rooted on publicBaseUrl().
 */
export function agentAvatarAbsoluteUrl(
  agent: { key?: string | null; avatarUrl?: string | null },
  getEnv: EnvGetter = defaultGetter,
): string {
  const path = agentAvatarPath(agent);
  if (/^https?:\/\//i.test(path)) return path;
  return `${publicBaseUrl(getEnv)}${path.startsWith('/') ? '' : '/'}${path}`;
}
