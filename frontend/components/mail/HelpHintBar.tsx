'use client';

/**
 * HelpHintBar — a one-time, dismissible strip under the mail top bar pointing
 * new users at the /help guide. Follows the HowAiHelps pattern: hidden until
 * the client-side localStorage check resolves (no SSR mismatch, no flash for
 * returning users), and dismissal persists forever. Deliberately subtle — one
 * quiet line, not a banner.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CloseIcon, QuestionIcon } from './icons';
import { Tooltip } from '@/components/Tooltip';

/** localStorage flag — '1' once the user has dismissed the hint. */
export const HELP_HINT_DISMISS_KEY = 'emailops.helpHintDismissed';

export function HelpHintBar() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(HELP_HINT_DISMISS_KEY) !== '1') setVisible(true);
    } catch {
      setVisible(true); // storage unavailable — fail open, orient anyway
    }
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      window.localStorage.setItem(HELP_HINT_DISMISS_KEY, '1');
    } catch {
      /* private mode — dismissed for this session only */
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-subtle bg-accent/[0.05] px-4 py-1.5 text-[12px] text-secondary">
      <QuestionIcon className="h-[14px] w-[14px] shrink-0 text-accent" />
      <span className="min-w-0 truncate">
        New here? Agents draft, you approve — the 3-minute guide covers the rest.
      </span>
      <Link
        href="/help"
        className="shrink-0 font-semibold text-accent hover:underline"
        onClick={dismiss}
      >
        Read the guide →
      </Link>
      <Tooltip content="Dismiss — Help stays in the left nav and behind the ? button">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss this hint"
          className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}
