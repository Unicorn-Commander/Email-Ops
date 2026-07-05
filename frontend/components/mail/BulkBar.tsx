'use client';

/**
 * Floating bulk-action bar — appears when thread rows are check-selected.
 * Archive / Trash / Spam / Mark read / Mark unread via the Wave-2 bulk
 * endpoint (the page hides this whole surface when that endpoint is missing).
 */

import { useState } from 'react';
import { Button, cn } from '@/components/ui';
import type { BulkAction } from '@/lib/mailApi';

const ACTIONS: { action: BulkAction; label: string; title: string }[] = [
  { action: 'archive', label: 'Archive', title: 'Archive selected (e)' },
  { action: 'trash', label: 'Trash', title: 'Move selected to trash (#)' },
  { action: 'spam', label: 'Spam', title: 'Mark selected as spam' },
  { action: 'read', label: 'Mark read', title: 'Mark selected read (⇧I)' },
  { action: 'unread', label: 'Mark unread', title: 'Mark selected unread (⇧U)' },
];

export function BulkBar({
  count,
  folder,
  onAction,
  onClear,
}: {
  count: number;
  /** Current folder — used to swap Archive→Move to inbox etc. */
  folder: string;
  onAction: (action: BulkAction) => Promise<{ ok: boolean; error?: string }>;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (count === 0) return null;

  async function run(action: BulkAction) {
    if (busy) return;
    setBusy(action);
    setError(null);
    const res = await onAction(action);
    setBusy(null);
    if (!res.ok && res.error) setError(res.error);
  }

  const actions = ACTIONS.filter((a) => a.action !== folder);
  const showInbox = folder !== 'inbox';

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        className={cn(
          'pointer-events-auto flex max-w-full flex-col items-center gap-1 rounded-token-lg border border-border bg-surface-elevated px-3 py-2 shadow-token-lg',
        )}
        role="toolbar"
        aria-label="Bulk actions"
      >
        <div className="flex max-w-full flex-wrap items-center justify-center gap-1">
          <span className="mr-1 shrink-0 text-xs font-medium text-primary">
            {count} selected
          </span>
          {showInbox && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => void run('inbox')}
              title="Move selected to inbox"
            >
              Move to inbox
            </Button>
          )}
          {actions.map((a) => (
            <Button
              key={a.action}
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void run(a.action)}
              title={a.title}
            >
              {busy === a.action ? '…' : a.label}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={onClear}
            aria-label="Clear selection"
            title="Clear selection"
          >
            ✕
          </Button>
        </div>
        {error && <p className="max-w-sm text-center text-[11px] text-danger">{error}</p>}
      </div>
    </div>
  );
}
