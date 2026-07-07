'use client';

/**
 * The shared account avatar — the Keycloak `picture` photo (suite avatar spine)
 * when we have one, else gradient initials. Used by the AccountMenu in every
 * shell so the signed-in identity looks the same on /mail and the other pages.
 */
import { cn } from '@/components/ui';
import type { EmailOpsUser } from '@/lib/api';

export function initialsOf(user: EmailOpsUser | null): string {
  const first = user?.firstName?.trim() ?? '';
  const last = user?.lastName?.trim() ?? '';
  if (first || last) return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || 'YO';
  const handle = (user?.username || user?.email || 'You').trim();
  const parts = handle.split(/[@\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.slice(0, 2) || 'YO').toUpperCase();
}

/** Avatar disc — the Keycloak photo when we have one, else gradient initials. */
export function Avatar({ user, size }: { user: EmailOpsUser | null; size: number }) {
  const cls = 'shrink-0 overflow-hidden rounded-full';
  if (user?.picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.picture}
        alt=""
        width={size}
        height={size}
        className={cn(cls, 'object-cover')}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cn(
        cls,
        'grid place-items-center bg-gradient-to-br from-[#f0883e] to-[#d9534f] font-semibold text-white',
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initialsOf(user)}
    </span>
  );
}
