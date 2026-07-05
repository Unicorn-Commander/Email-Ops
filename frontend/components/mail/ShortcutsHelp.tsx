'use client';

/** The "?" keyboard-shortcuts reference dialog. */

import { Dialog } from '@/components/ui';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Navigate',
    rows: [
      ['j / k', 'Next / previous conversation'],
      ['Enter or o', 'Open conversation'],
      ['u', 'Back to list'],
      ['/', 'Focus search'],
    ],
  },
  {
    title: 'Act',
    rows: [
      ['e', 'Archive'],
      ['#', 'Trash'],
      ['x', 'Select conversation'],
      ['⇧I / ⇧U', 'Mark read / unread'],
    ],
  },
  {
    title: 'Write',
    rows: [
      ['r', 'Reply'],
      ['a', 'Reply all'],
      ['f', 'Forward'],
    ],
  },
];

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded-token border border-border bg-surface-overlay px-1.5 py-0.5 font-mono text-[11px] text-secondary">
      {children}
    </kbd>
  );
}

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Keyboard shortcuts"
      description="Work your mail without touching the mouse. Press ? anytime to open this."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
              {g.title}
            </p>
            <ul className="mt-2 space-y-1.5">
              {g.rows.map(([keys, what]) => (
                <li key={keys} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-tertiary">{what}</span>
                  <span className="flex shrink-0 gap-1">
                    {keys.split(' / ').map((k) => (
                      <Key key={k}>{k}</Key>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
