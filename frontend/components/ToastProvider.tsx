'use client';

/**
 * App-wide toasts — a tiny imperative notification surface.
 *
 * Mirrors the imperative-provider shape of `ConfirmProvider` (a context that
 * hands back a function), but instead of a single modal it owns a STACK of
 * auto-expiring, dismissible toasts rendered bottom-right. `useToast()` returns
 * `toast({ title, body?, tone? })`; each call pushes a toast that auto-dismisses
 * after a few seconds (or when the user dismisses it).
 *
 * It is mounted in `app/layout.tsx` alongside `ConfirmProvider` (just inside it)
 * so toasts are available app-wide — most notably to the Phase-C
 * `UiCommandBridge`, which raises one whenever an agent drives the UI.
 *
 * Accessibility: each toast is a `role="status"` + `aria-live="polite"` region so
 * a screen reader announces it without stealing focus. Visuals use the shared
 * design tokens (no hardcoded colors), tone-keyed like the rest of the suite.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';

/** Toast severity → the tone-keyed accent (info | success | warning). */
export type ToastTone = 'info' | 'success' | 'warning';

export interface ToastOptions {
  title: string;
  body?: string;
  tone?: ToastTone;
  /** Override the auto-dismiss delay (ms). Defaults to {@link DEFAULT_DURATION}. */
  duration?: number;
}

/** The imperative API handed back by `useToast()`. */
export type ToastFn = (opts: ToastOptions) => void;

/** A live toast in the stack (an id + its options, resolved tone). */
interface ActiveToast extends ToastOptions {
  id: number;
  tone: ToastTone;
}

/** Auto-dismiss after this many ms unless the caller overrides it. */
const DEFAULT_DURATION = 5000;

/** Inert default so `useToast` never throws if read outside the provider. */
const ToastContext = createContext<ToastFn>(() => {});

/** Tone → the toast's left accent bar + ring color (token classes only). */
const TONE_RING: Record<ToastTone, string> = {
  info: 'border-info/30',
  success: 'border-success/30',
  warning: 'border-warning/30',
};

/** Tone → the leading status dot color. */
const TONE_DOT: Record<ToastTone, string> = {
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  // Monotonic id source (SSR-safe) + the per-toast dismiss timers, so a manual
  // dismiss / unmount can cancel the pending auto-dismiss.
  const idRef = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    ({ title, body, tone = 'info', duration = DEFAULT_DURATION }) => {
      const id = idRef.current++;
      // Cap the stack so an agent flooding ui_notify can't pile up unbounded DOM.
      setToasts((list) => [...list, { id, title, body, tone, duration }].slice(-6));
      const timer = setTimeout(() => dismiss(id), duration);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  // Cancel every pending timer on unmount so nothing fires into a dead tree.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Positioning layer — lets clicks pass through the gaps between toasts. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-end gap-2 p-4 sm:p-6">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ActiveToast; onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3',
        'rounded-token-lg border bg-surface-elevated p-3 text-secondary shadow-token-lg',
        TONE_RING[toast.tone],
      )}
    >
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TONE_DOT[toast.tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-primary">{toast.title}</p>
        {toast.body && <p className="mt-0.5 text-xs leading-5 text-tertiary">{toast.body}</p>}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-token text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary"
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}

/** Read the imperative `toast()` function (safe no-op outside the provider). */
export function useToast(): ToastFn {
  return useContext(ToastContext);
}
