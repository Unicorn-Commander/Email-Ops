'use client';

/**
 * CleanupTargetsList — the concrete "what would this touch" preview for a staged
 * mailbox-cleanup batch. Renders the verb + total, a bounded list of the affected
 * rows (top senders + counts for an external batch, subjects for a native inbox
 * batch), how much it frees, and how many protected messages it deliberately
 * kept. Shared by the Agent-Inbox ReviewCard and the in-chat confirm card so a
 * human sees exactly the same targets wherever the batch surfaces.
 *
 * Purely presentational + tokenized (light/dark aware); the data comes from
 * `@/lib/cleanupTargets`. Degrades to a single header line when no rows resolved.
 */

import { cn } from '@/components/ui';
import { ArchiveIcon, TrashIcon } from './icons';
import { formatBytes, remainingCount, type CleanupTargets } from '@/lib/cleanupTargets';

export function CleanupTargetsList({
  targets,
  className,
}: {
  targets: CleanupTargets;
  className?: string;
}) {
  const destructive = targets.verb !== 'Archive';
  const Icon = destructive ? TrashIcon : ArchiveIcon;
  const noun = targets.scope === 'threads' ? 'thread' : 'message';
  const where =
    targets.provider === 'this inbox'
      ? ' in this inbox'
      : targets.provider
        ? ` on ${targets.provider}`
        : '';
  const frees = formatBytes(targets.frees_bytes);
  const more = remainingCount(targets);

  return (
    <div
      className={cn(
        'rounded-token border border-accent/25 bg-accent/[0.04] p-2.5',
        className,
      )}
    >
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] font-medium text-secondary">
        <Icon
          className={cn('h-3.5 w-3.5 shrink-0', destructive ? 'text-danger' : 'text-accent')}
          aria-hidden="true"
        />
        <span className={cn('font-semibold', destructive ? 'text-danger' : 'text-accent')}>
          {targets.verb}
        </span>
        <span className="font-semibold text-primary">{targets.total.toLocaleString()}</span>
        <span>
          {noun}
          {targets.total === 1 ? '' : 's'}
          {where}
        </span>
        {frees && <span className="text-tertiary">· frees {frees}</span>}
        {targets.protected_count ? (
          <span className="text-tertiary">· {targets.protected_count} protected kept</span>
        ) : null}
      </p>

      {targets.rows.length > 0 && (
        <ul className="mt-2 space-y-1">
          {targets.rows.map((row, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-3 text-[11.5px] leading-4"
            >
              <span className="min-w-0 truncate text-tertiary">
                {targets.scope === 'threads'
                  ? row.subject || '(no subject)'
                  : row.sender || '(unknown sender)'}
                {targets.scope === 'threads' && row.sender ? (
                  <span className="ml-1.5 text-muted">· {row.sender}</span>
                ) : null}
              </span>
              {targets.scope === 'messages' && row.count != null ? (
                <span className="shrink-0 font-mono text-[10.5px] text-muted">
                  {row.count.toLocaleString()}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {more > 0 && targets.rows.length > 0 && (
        <p className="mt-1.5 text-[10.5px] text-muted">
          + {more.toLocaleString()} more {noun}
          {more === 1 ? '' : 's'}
          {targets.scope === 'messages' ? ' across other senders' : ''}
        </p>
      )}
    </div>
  );
}

/** A one-line, plain-text version of the target header (for confirm-dialog copy). */
export function cleanupTargetsSentence(targets: CleanupTargets): string {
  const noun = targets.scope === 'threads' ? 'thread' : 'message';
  const where =
    targets.provider === 'this inbox'
      ? ' in this inbox'
      : targets.provider
        ? ` on ${targets.provider}`
        : '';
  const senders =
    targets.scope === 'messages' && targets.rows.length > 0
      ? ` from ${targets.rows.length}${targets.truncated ? '+' : ''} sender${targets.rows.length === 1 ? '' : 's'}`
      : '';
  return `${targets.verb} ${targets.total.toLocaleString()} ${noun}${targets.total === 1 ? '' : 's'}${senders}${where}?`;
}
