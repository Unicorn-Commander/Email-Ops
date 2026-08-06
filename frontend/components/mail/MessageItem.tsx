'use client';

/**
 * One message inside the open thread (right pane).
 *
 * Conversation UX: all but the last message collapse to a one-line header
 * (sender + snippet + date); click expands. Expanded messages render the
 * sanitized `html_body` (isolated iframe, remote images blocked by default,
 * cid images resolved, quoted trailers behind "•••"), falling back to
 * `text_body` then `preview`. Attachments list with authenticated downloads,
 * and Reply / Reply-all / Forward actions.
 */

import { useCallback, useMemo } from 'react';
import { Badge, cn, type BadgeVariant } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import { fetchMailBlob, type MailAttachment, type MessageView } from '@/lib/mailApi';
import { formatWhen, participantLabel } from './useMailClient';
import { HtmlEmailBody } from './HtmlEmailBody';
import { MessageAttachments } from './AttachmentList';

const DIRECTION_META: Record<string, { label: string; tone: BadgeVariant }> = {
  sent: { label: 'sent', tone: 'info' },
  received: { label: 'received', tone: 'neutral' },
  draft: { label: 'draft', tone: 'warning' },
};

/** Quiet dot tint per direction tone — lets a collapsed row show who-said-what
 *  at a glance without competing with the sender/snippet. */
const TONE_DOT: Partial<Record<BadgeVariant, string>> = {
  info: 'text-info',
  neutral: 'text-muted',
  warning: 'text-warning',
};

function snippetOf(message: MessageView): string {
  const raw = message.preview ?? message.text_body ?? '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 140);
}

export function MessageItem({
  message,
  workspaceId,
  mailboxId,
  collapsed,
  isLast,
  onToggle,
  onReply,
  onReplyAll,
  onForward,
}: {
  message: MessageView;
  workspaceId: string;
  /** The mailbox the thread was opened from (routes blob fetches). */
  mailboxId: string | null;
  collapsed: boolean;
  /** The newest message in the thread — its reply actions live in the reader's
   *  single ReplyActionBar / composer below, so its own footer is suppressed. */
  isLast?: boolean;
  onToggle: () => void;
  onReply?: (message: MessageView) => void;
  onReplyAll?: (message: MessageView) => void;
  onForward?: (message: MessageView) => void;
}) {
  const when = useMemo(() => formatWhen(message.sent_at), [message.sent_at]);
  const dir = DIRECTION_META[message.direction] ?? {
    label: message.direction || 'message',
    tone: 'neutral' as BadgeVariant,
  };
  const toLabel = useMemo(
    () => message.to.map((t) => participantLabel(t)).join(', '),
    [message.to],
  );
  const ccLabel = useMemo(
    () => (message.cc ?? []).map((t) => participantLabel(t)).join(', '),
    [message.cc],
  );
  const attachments = message.attachments ?? [];
  const fileCount = attachments.filter((a) => !a.cid).length;

  const resolveCidUrl = useCallback(
    async (att: MailAttachment) => {
      if (!mailboxId) throw new Error('No mailbox for blob fetch.');
      const blob = await fetchMailBlob(workspaceId, mailboxId, att.blob_id, att.name, att.type);
      return URL.createObjectURL(blob);
    },
    [workspaceId, mailboxId],
  );

  if (collapsed) {
    return (
      <li className="py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            '-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1.5 text-left',
            'transition-colors duration-fast ease-token hover:bg-surface-overlay/50',
          )}
          title="Expand message"
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-current',
              TONE_DOT[dir.tone] ?? 'text-muted',
            )}
          />
          <span className="sr-only">{dir.label}: </span>
          <span
            className={cn(
              'w-32 shrink-0 truncate text-xs sm:w-40',
              message.is_unread ? 'font-semibold text-primary' : 'font-medium text-secondary',
            )}
          >
            {participantLabel(message.from)}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
            {snippetOf(message)}
          </span>
          {fileCount > 0 && (
            <span className="flex shrink-0 items-center gap-0.5 text-muted" title={`${fileCount} attachment${fileCount === 1 ? '' : 's'}`}>
              <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
                <path
                  d="M21 12.5l-8.5 8.5a5.66 5.66 0 01-8-8l9-9a3.77 3.77 0 015.3 5.3l-9 9a1.89 1.89 0 01-2.7-2.7l8.3-8.3"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-[10px] font-medium tabular-nums">{fileCount}</span>
            </span>
          )}
          {when && <span className="shrink-0 text-[10px] text-muted mono">{when}</span>}
        </button>
      </li>
    );
  }

  const html = message.html_body?.trim() || null;
  const text = message.text_body ?? message.preview ?? '';

  return (
    <li className="py-3.5">
      <button
        type="button"
        onClick={onToggle}
        className="-mx-2 flex w-full flex-wrap items-center gap-2 rounded-lg px-2 py-0.5 text-left transition-colors hover:bg-surface-overlay/40"
        title="Collapse message"
      >
        <span className="min-w-0 truncate text-sm font-medium text-primary">
          {participantLabel(message.from)}
        </span>
        <Badge variant={dir.tone}>{dir.label}</Badge>
        {when && <span className="ml-auto shrink-0 text-[10px] text-muted mono">{when}</span>}
      </button>
      {toLabel && <p className="mt-0.5 truncate text-[11px] text-muted mono">to {toLabel}</p>}
      {ccLabel && <p className="truncate text-[11px] text-muted mono">cc {ccLabel}</p>}

      <div className="eops-rise-in mt-2">
        {html ? (
          <HtmlEmailBody
            html={html}
            senderAddress={message.from?.address ?? null}
            attachments={attachments}
            resolveCidUrl={resolveCidUrl}
          />
        ) : text ? (
          <div className="w-full max-w-[680px]">
            <p className="whitespace-pre-wrap text-sm leading-6 text-secondary">{text}</p>
          </div>
        ) : (
          <p className="text-xs italic text-muted">No content.</p>
        )}
      </div>

      {mailboxId && attachments.length > 0 && (
        <MessageAttachments
          attachments={attachments}
          workspaceId={workspaceId}
          mailboxId={mailboxId}
        />
      )}

      {!isLast && (onReply || onReplyAll || onForward) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1 border-t border-subtle pt-2">
          {onReply && (
            <MessageAction label="Reply" hint="r" onClick={() => onReply(message)} />
          )}
          {onReplyAll && (
            <MessageAction label="Reply all" hint="a" onClick={() => onReplyAll(message)} />
          )}
          {onForward && (
            <MessageAction label="Forward" hint="f" onClick={() => onForward(message)} />
          )}
        </div>
      )}
    </li>
  );
}

function MessageAction({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip content={hint ? `${label} (${hint})` : label}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-token px-2 py-1 text-xs font-medium text-tertiary',
          'transition-colors duration-fast ease-token hover:bg-surface-overlay/60 hover:text-primary',
        )}
      >
        {label}
      </button>
    </Tooltip>
  );
}
