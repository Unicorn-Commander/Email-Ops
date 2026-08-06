'use client';

/**
 * The shared account menu: the avatar disc that opens a dropdown with the
 * signed-in name/email, a theme toggle, "Accounts & settings", and Sign out.
 * Self-hydrating (no props) so any shell can drop it in and get the real photo +
 * name. This is the one identity affordance shared across /mail and the other
 * pages, so the avatar looks the same everywhere.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui';
import { useTheme } from '@/state/theme';
import { clearSession } from '@/lib/api';
import { SunIcon, MoonIcon, GearIcon } from '@/components/mail/icons';
import { Avatar } from './Avatar';
import { useHydratedUser } from './useHydratedUser';

export function AccountMenu({ size = 30 }: { size?: number }) {
  const router = useRouter();
  const user = useHydratedUser();
  const { resolved, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
    user?.username ||
    user?.email ||
    'Signed in';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user?.email ?? 'Account'}
        aria-label="Account menu"
        className={cn(
          'shrink-0 rounded-full transition-shadow',
          open && 'ring-2 ring-accent/60 ring-offset-2 ring-offset-surface-raised',
        )}
      >
        <Avatar user={user} size={size} />
      </button>

      {open && (
        <div
          role="menu"
          className="eops-rise-in absolute right-0 top-[calc(100%+8px)] z-50 w-64 overflow-hidden rounded-xl border border-subtle bg-surface-overlay shadow-pop"
        >
          <div className="flex items-center gap-3 border-b border-subtle px-3.5 py-3">
            <Avatar user={user} size={36} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-primary">{name}</span>
              {user?.email && (
                <span className="block truncate text-[12px] text-tertiary">{user.email}</span>
              )}
            </span>
          </div>

          <div className="p-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary"
            >
              {resolved === 'dark' ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
              {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                router.push('/accounts');
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary"
            >
              <GearIcon className="h-4 w-4" />
              Accounts &amp; settings
            </button>
          </div>

          <div className="border-t border-subtle p-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                clearSession();
                router.replace('/auth/login');
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-secondary transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <SignOutIcon className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
      <path d="M10 17l-5-5 5-5" />
      <path d="M5 12h11" />
    </svg>
  );
}
