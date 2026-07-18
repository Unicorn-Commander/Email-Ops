'use client';

/**
 * HowAiHelps — a small, dismissible first-run orientation card for the daily
 * brief: three rows that answer the "how does the AI actually help me" question
 * (triage/filing · drafted replies you approve · ask-your-inbox chat), each with
 * a direct jump into the real surface. Not a marketing banner — it renders on
 * the quiet neutral tokens and disappears forever once dismissed.
 *
 * Dismissal persists in localStorage (AI_HELP_DISMISS_KEY). It can be brought
 * back — e.g. from a ⌘K command — via `requestAiHelpCard()`, which clears the
 * flag and pings every mounted card through a window event. The component
 * renders nothing until the client-side dismissal check resolves, so dismissed
 * users never see a flash and SSR markup never mismatches.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui';
import { CloseIcon, PencilIcon } from './icons';

/** localStorage flag — '1' once the user has dismissed the card. */
export const AI_HELP_DISMISS_KEY = 'emailops.aiHelpDismissed';
/** Window event that re-opens every mounted card (used by requestAiHelpCard). */
export const AI_HELP_SHOW_EVENT = 'emailops:ai-help:show';

/** Re-show the orientation card (clears the dismissal + notifies mounted cards). */
export function requestAiHelpCard(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(AI_HELP_DISMISS_KEY);
  } catch {
    /* storage unavailable (private mode) — the event still shows this session */
  }
  window.dispatchEvent(new Event(AI_HELP_SHOW_EVENT));
}

export interface HowAiHelpsProps {
  /** Open the Rules dialog (triage/filing row). Omit to hide the row's link. */
  onOpenRules?: () => void;
  /** Open the approvals surface (drafted-replies row). Omit to hide the link. */
  onOpenApprovals?: () => void;
  /** Focus the agent chat (ask-anything row). Omit to hide the link. */
  onFocusChat?: () => void;
  className?: string;
}

/** Funnel glyph (triage/rules) — same stroke language as icons.tsx. */
function FunnelGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z" />
    </svg>
  );
}

/** Chat-bubble glyph (icons.tsx has none). */
function ChatGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    </svg>
  );
}

function HelpRow({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent"
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium leading-tight text-primary">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-[1.4] text-tertiary">{detail}</span>
      </span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 whitespace-nowrap text-[12px] font-semibold text-accent hover:underline"
        >
          {action.label} →
        </button>
      )}
    </li>
  );
}

export function HowAiHelps({
  onOpenRules,
  onOpenApprovals,
  onFocusChat,
  className,
}: HowAiHelpsProps) {
  // Hidden until the client-side check says otherwise (no flash, no hydration
  // mismatch). Storage failures fail OPEN — better to orient than to hide.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(AI_HELP_DISMISS_KEY) !== '1') setVisible(true);
    } catch {
      setVisible(true);
    }
    const onShow = () => setVisible(true);
    window.addEventListener(AI_HELP_SHOW_EVENT, onShow);
    return () => window.removeEventListener(AI_HELP_SHOW_EVENT, onShow);
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    try {
      window.localStorage.setItem(AI_HELP_DISMISS_KEY, '1');
    } catch {
      /* storage unavailable — dismiss for this session only */
    }
  }, []);

  if (!visible) return null;

  return (
    <section
      aria-label="How your AI helps"
      className={cn(
        'overflow-hidden rounded-token-lg border border-subtle bg-surface-base/50 eops-rise-in',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
          How your AI helps
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss this orientation card"
          title="Dismiss — reopen anytime from the ⌘K menu"
          className="grid h-6 w-6 place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <ul className="pb-2.5">
        <HelpRow
          icon={<FunnelGlyph className="h-4 w-4" />}
          title="Agents triage and file inbound mail"
          detail="Rules route what arrives; cleanup batches clear the clutter."
          action={onOpenRules ? { label: 'Rules', onClick: onOpenRules } : undefined}
        />
        <HelpRow
          icon={<PencilIcon className="h-4 w-4" />}
          title="Agents draft replies"
          detail="You approve before anything sends."
          action={
            onOpenApprovals ? { label: 'Review approvals', onClick: onOpenApprovals } : undefined
          }
        />
        <HelpRow
          icon={<ChatGlyph className="h-4 w-4" />}
          title="Ask your inbox anything"
          detail="Chat with your agents about the mail in front of you."
          action={onFocusChat ? { label: 'Open chat', onClick: onFocusChat } : undefined}
        />
      </ul>
    </section>
  );
}
