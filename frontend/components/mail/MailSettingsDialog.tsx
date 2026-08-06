'use client';

/**
 * Mail settings — the small per-user preferences that live in the browser:
 * desktop notifications (opt-in, permission-gated) and the undo-send window.
 * Both are localStorage-backed; nothing here writes to the server.
 */

import { useEffect, useState } from 'react';
import { Dialog, Select } from '@/components/ui';
import { NotificationsToggle } from './NotificationsToggle';
import { readUndoSeconds, writeUndoSeconds } from './UndoSendBar';

const UNDO_CHOICES = [0, 5, 10, 20, 30] as const;

export function MailSettingsDialog({
  open,
  onClose,
  notifications,
}: {
  open: boolean;
  onClose: () => void;
  notifications: {
    supported: boolean;
    enabled: boolean;
    permission: NotificationPermission | 'unsupported';
    setEnabled: (on: boolean) => Promise<void>;
  };
}) {
  const [undoSeconds, setUndoSeconds] = useState(10);

  // Read the stored preference when the dialog opens (never during SSR).
  useEffect(() => {
    if (open) setUndoSeconds(readUndoSeconds());
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Mail settings"
      description="Preferences for this browser."
    >
      <div className="space-y-4">
        <NotificationsToggle
          supported={notifications.supported}
          enabled={notifications.enabled}
          permission={notifications.permission}
          onChange={notifications.setEnabled}
        />

        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="undo-send-window" className="text-[13px] font-medium text-primary">
              Undo send
            </label>
            <p className="text-[11px] text-tertiary">
              How long a sent message can be recalled before it leaves.
            </p>
          </div>
          <Select
            id="undo-send-window"
            className="w-28 shrink-0"
            value={String(undoSeconds)}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              setUndoSeconds(n);
              writeUndoSeconds(n);
            }}
          >
            {UNDO_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? 'Off' : `${n} seconds`}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Dialog>
  );
}
