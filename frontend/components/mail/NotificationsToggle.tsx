'use client';

/**
 * A small labeled switch row for the desktop-notifications preference — built
 * to drop into an existing settings/overflow menu. Pairs with
 * `useDesktopNotifications`: the page passes that hook's `enabled` /
 * `permission` / `supported` straight through and routes `onChange` to its
 * `setEnabled` (which may prompt for browser permission, hence async).
 *
 * Truthful rendering: the switch shows the EFFECTIVE state — on only when the
 * preference is on AND the browser will actually deliver. If the site
 * permission later regresses, the switch reads off; flipping it on again
 * re-prompts. When permission is denied (or the API is missing) the switch is
 * disabled and the helper line says why.
 */

import { useId, useState } from 'react';
import { cn } from '@/components/ui';

export interface NotificationsToggleProps {
  enabled: boolean;
  permission: NotificationPermission | 'unsupported';
  supported: boolean;
  onChange: (on: boolean) => void | Promise<void>;
}

export function NotificationsToggle({
  enabled,
  permission,
  supported,
  onChange,
}: NotificationsToggleProps) {
  const switchId = useId();
  const helperId = useId();
  // Guards double-clicks while an async onChange (the permission prompt) is pending.
  const [busy, setBusy] = useState(false);

  const unsupported = !supported || permission === 'unsupported';
  const blocked = permission === 'denied';
  const disabled = unsupported || blocked || busy;
  const active = enabled && permission === 'granted';

  const helper = unsupported
    ? 'Not supported in this browser'
    : blocked
      ? 'Blocked in browser settings'
      : 'Pings you about new inbox mail while you’re away';

  const toggle = async (): Promise<void> => {
    if (disabled) return;
    setBusy(true);
    try {
      await onChange(!active);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <label
          htmlFor={switchId}
          className={cn(
            'block text-[13px] font-medium text-primary',
            unsupported || blocked ? 'opacity-60' : 'cursor-pointer',
          )}
        >
          Desktop notifications
        </label>
        <p id={helperId} className={cn('text-[11px]', blocked ? 'text-warning' : 'text-tertiary')}>
          {helper}
        </p>
      </div>
      <button
        id={switchId}
        type="button"
        role="switch"
        aria-checked={active}
        aria-describedby={helperId}
        disabled={disabled}
        onClick={() => void toggle()}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
          active ? 'border-transparent bg-accent' : 'border-subtle bg-surface-overlay',
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:brightness-110',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
            active ? 'translate-x-[19px]' : 'translate-x-[3px]',
          )}
        />
      </button>
    </div>
  );
}
