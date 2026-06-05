'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  destructive?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingState | null>(null);
  const settledRef = useRef(false);

  const confirm = useCallback<ConfirmFn>((opts) => {
    settledRef.current = false;
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback(
    (ok: boolean) => {
      if (settledRef.current) return;
      settledRef.current = true;
      pending?.resolve(ok);
      setPending(null);
    },
    [pending],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
        title={pending?.title ?? ''}
        {...(pending?.description !== undefined ? { description: pending.description } : {})}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => settle(false)}>
              {pending?.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              variant={pending?.destructive ? 'danger' : 'primary'}
              size="sm"
              onClick={() => settle(true)}
              autoFocus
            >
              {pending?.confirmLabel ?? 'OK'}
            </Button>
          </>
        }
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return useMemo<ConfirmFn>(() => {
    if (ctx) return ctx;
    return async (opts) =>
      window.confirm(typeof opts.title === 'string' ? opts.title : 'Are you sure?');
  }, [ctx]);
}
