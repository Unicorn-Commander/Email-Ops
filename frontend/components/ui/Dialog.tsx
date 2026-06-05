import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="lo-dialog-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <RadixDialog.Content
          className={cn(
            'lo-dialog-content fixed left-1/2 top-1/2 z-50',
            'w-[calc(100vw-2rem)] max-w-md',
            'rounded-token-lg border border-border bg-surface-elevated text-secondary shadow-token-lg',
            'focus:outline-none',
            className,
          )}
        >
          <div className="p-5">
            <RadixDialog.Title className="text-base font-semibold text-primary">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-1.5 text-sm text-tertiary">
                {description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
            {children ? <div className="mt-4 text-sm text-secondary">{children}</div> : null}
          </div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-subtle p-4">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogPrimitive = RadixDialog;
