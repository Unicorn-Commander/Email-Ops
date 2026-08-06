'use client';

/**
 * Floating bulk-action bar — appears when thread rows are check-selected.
 * Archive / Trash / Spam / Mark read / Mark unread via the Wave-2 bulk
 * endpoint (the page hides this whole surface when that endpoint is missing),
 * plus Move-to-folder when the mailbox has custom folders.
 */

import { useEffect, useRef, useState } from 'react';
import { Button, cn } from '@/components/ui';
import type { BulkAction, MailFolderView } from '@/lib/mailApi';
import { FolderIcon } from './icons';

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
  customFolders = [],
  onMoveToFolder,
}: {
  count: number;
  /** Current folder — used to swap Archive→Move to inbox etc. */
  folder: string;
  onAction: (action: BulkAction) => Promise<{ ok: boolean; error?: string }>;
  onClear: () => void;
  /** Custom folders to file the selection into; empty hides the Move control. */
  customFolders?: MailFolderView[];
  onMoveToFolder?: (folderId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (count === 0) return null;

  const anyBusy = busy !== null || moving;

  async function run(action: BulkAction) {
    if (anyBusy) return;
    setBusy(action);
    setError(null);
    const res = await onAction(action);
    setBusy(null);
    if (!res.ok && res.error) setError(res.error);
  }

  async function move(folderId: string) {
    if (anyBusy || !onMoveToFolder) return;
    setMoving(true);
    setError(null);
    const res = await onMoveToFolder(folderId);
    setMoving(false);
    if (!res.ok && res.error) setError(res.error);
  }

  const actions = ACTIONS.filter((a) => a.action !== folder);
  const showInbox = folder !== 'inbox';
  const canMove = !!onMoveToFolder && customFolders.length > 0;

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
              disabled={anyBusy}
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
              disabled={anyBusy}
              onClick={() => void run(a.action)}
              title={a.title}
            >
              {busy === a.action ? '…' : a.label}
            </Button>
          ))}
          {canMove && (
            <BulkMoveMenu
              folders={customFolders}
              disabled={anyBusy}
              busy={moving}
              onPick={(id) => void move(id)}
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={anyBusy}
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

/**
 * "Move to…" popover for the bulk bar. Because the bar is docked to the bottom
 * of the viewport, the menu opens UPWARD (bottom-full). Closes on pick, outside
 * click, or Escape. Neutral tokens — folders are a human surface, not agent.
 */
function BulkMoveMenu({
  folders,
  onPick,
  disabled,
  busy,
}: {
  folders: MailFolderView[];
  onPick: (folderId: string) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        title="Move selected to a folder"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy ? (
          '…'
        ) : (
          <span className="flex items-center gap-1.5">
            <FolderIcon className="h-3.5 w-3.5" />
            Move to…
          </span>
        )}
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Move selected to folder"
          className="absolute bottom-full right-0 z-50 mb-1 max-h-72 w-56 overflow-y-auto rounded-token-lg border border-border bg-surface-overlay p-1 shadow-token-lg"
        >
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
            Move to folder
          </p>
          {folders.map((f) => (
            <button
              key={f.id}
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(f.id);
              }}
              className="flex w-full items-center gap-2 rounded-token px-2 py-1.5 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary"
            >
              <FolderIcon className="h-4 w-4 shrink-0 text-tertiary" />
              <span className="flex-1 truncate">{f.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
