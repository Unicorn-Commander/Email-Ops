'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';

/**
 * Copies `value` to the clipboard. The button label never includes `value`,
 * so a token is not repeated in the accessible name after the one-time reveal.
 */
export function CopyButton({
  value,
  label,
  disabled = false,
}: {
  value: string;
  label: string;
  disabled?: boolean;
}) {
  const [note, setNote] = useState<'idle' | 'copied' | 'failed'>('idle');

  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={disabled || !value}
      onClick={() => {
        const writer = navigator.clipboard?.writeText;
        if (!writer) {
          setNote('failed');
          return;
        }
        void writer.call(navigator.clipboard, value).then(
          () => {
            setNote('copied');
            window.setTimeout(() => setNote('idle'), 2000);
          },
          () => setNote('failed'),
        );
      }}
    >
      {note === 'copied' ? 'Copied' : note === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}
