'use client';

/**
 * AgentAvatar — the one tiny shared avatar disc for AGENT identities (the
 * human-account analogue is components/account/Avatar.tsx).
 *
 * Resolution rule (mirrors backend/src/agents/agent-avatar.ts — one rule,
 * both sides):
 *   src = agent.avatar_url when set
 *       → else /agent-avatars/<key>.svg (the shipped placeholder — the browser
 *         just tries it)
 *       → onError falls back to /agent-avatars/default.svg.
 *
 * Decorative by default (alt='') — every call site renders the agent's name
 * right next to the disc; pass `label` when it stands alone.
 */

import { useEffect, useState } from 'react';
import { cn } from '@/components/ui';

const DEFAULT_SRC = '/agent-avatars/default.svg';

/** The preferred (pre-fallback) avatar source for an agent identity. */
export function agentAvatarSrc(
  agentKey: string | null | undefined,
  avatarUrl?: string | null,
): string {
  const own = avatarUrl?.trim();
  if (own) return own;
  const key = agentKey?.trim().toLowerCase();
  return key ? `/agent-avatars/${encodeURIComponent(key)}.svg` : DEFAULT_SRC;
}

export function AgentAvatar({
  agentKey,
  avatarUrl,
  size = 24,
  label,
  className,
}: {
  /** The agent's stable key (drives the per-key placeholder lookup). */
  agentKey: string | null | undefined;
  /** Explicit avatar URL from the registry (wins when set). */
  avatarUrl?: string | null;
  /** Disc diameter in px. */
  size?: number;
  /** Accessible label; omit when the agent's name is rendered right beside it. */
  label?: string;
  className?: string;
}) {
  const preferred = agentAvatarSrc(agentKey, avatarUrl);
  const [src, setSrc] = useState(preferred);
  // Re-resolve when the subject changes (the panel is reused across agents).
  useEffect(() => setSrc(preferred), [preferred]);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={label ?? ''}
      width={size}
      height={size}
      draggable={false}
      onError={() => {
        if (src !== DEFAULT_SRC) setSrc(DEFAULT_SRC);
      }}
      className={cn('shrink-0 select-none rounded-full object-cover', className)}
      style={{ width: size, height: size }}
    />
  );
}
